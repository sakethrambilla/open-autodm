-- Cron recovery and maintenance: bounded publication retries, stranded
-- suspended-job recovery, a maintenance lease lock and batched cleanup.

-- ── maintenance_locks ──────────────────────────────────────────────────────
-- A lease row rather than an advisory lock: PostgREST calls do not share a
-- session, so a session lock could not outlive the RPC that took it.
CREATE TABLE public.maintenance_locks (
  name          TEXT        PRIMARY KEY,
  owner         TEXT        NOT NULL,
  locked_until  TIMESTAMPTZ NOT NULL
);

ALTER TABLE public.maintenance_locks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.maintenance_locks FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.try_maintenance_lock(p_name TEXT, p_owner TEXT, p_seconds INTEGER)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_rows INTEGER;
BEGIN
  INSERT INTO public.maintenance_locks AS ml (name, owner, locked_until)
  VALUES (p_name, p_owner, NOW() + make_interval(secs => p_seconds))
  ON CONFLICT (name) DO UPDATE
    SET owner = EXCLUDED.owner, locked_until = EXCLUDED.locked_until
    WHERE ml.locked_until < NOW();
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_maintenance_lock(p_name TEXT, p_owner TEXT)
RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  DELETE FROM public.maintenance_locks WHERE name = p_name AND owner = p_owner;
$$;

-- ── Publication claims ─────────────────────────────────────────────────────
-- Generation counts publish attempts; rows at the cap stay visible as
-- publish_state='failed' and are no longer claimed.
CREATE OR REPLACE FUNCTION public.claim_inbox_publication(p_limit INTEGER DEFAULT 100, p_lease_seconds INTEGER DEFAULT 120)
RETURNS TABLE (id UUID, instagram_account_id UUID, publish_generation INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  UPDATE public.webhook_inbox wi
  SET publish_state = 'publishing',
      publish_generation = wi.publish_generation + 1,
      publish_lease_until = NOW() + make_interval(secs => p_lease_seconds)
  WHERE wi.id IN (
    SELECT x.id FROM public.webhook_inbox x
    WHERE x.next_publish_at <= NOW()
      AND x.state = 'received'
      AND x.publish_generation < 20
      AND (x.publish_state IN ('pending', 'failed')
           OR (x.publish_state = 'publishing' AND x.publish_lease_until < NOW()))
    ORDER BY x.next_publish_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  RETURNING wi.id, wi.instagram_account_id, wi.publish_generation;
END;
$$;

-- Also claims suspended jobs whose wake time passed 15+ minutes ago: a live
-- sleeping run re-claims within seconds of waking, so these lost their run.
-- next_publish_at is pushed out so a stranded job is republished at most
-- every 15 minutes.
CREATE OR REPLACE FUNCTION public.claim_job_publication(p_limit INTEGER DEFAULT 100, p_lease_seconds INTEGER DEFAULT 120)
RETURNS TABLE (id UUID, instagram_account_id TEXT, publish_generation INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  UPDATE public.job_queue jq
  SET publish_state = 'publishing',
      publish_generation = jq.publish_generation + 1,
      publish_lease_until = NOW() + make_interval(secs => p_lease_seconds),
      next_publish_at = CASE WHEN jq.status = 'suspended' THEN NOW() + INTERVAL '15 minutes' ELSE jq.next_publish_at END
  WHERE jq.id IN (
    SELECT x.id FROM public.job_queue x
    WHERE x.next_publish_at <= NOW()
      AND x.publish_generation < 20
      AND (
        (x.status = 'pending'
         AND (x.publish_state IN ('pending', 'failed')
              OR (x.publish_state = 'publishing' AND x.publish_lease_until < NOW())))
        OR (x.status = 'suspended'
            AND x.run_after < NOW() - INTERVAL '15 minutes'
            AND (x.publish_state <> 'publishing' OR x.publish_lease_until < NOW()))
      )
    ORDER BY x.next_publish_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  RETURNING jq.id, jq.payload->>'instagramAccountId', jq.publish_generation;
END;
$$;

-- Failed publications back off exponentially (30s doubling, capped at 1h).
CREATE OR REPLACE FUNCTION public.complete_publication(
  p_table       TEXT,
  p_id          UUID,
  p_generation  INTEGER,
  p_published   BOOLEAN,
  p_error       TEXT DEFAULT NULL,
  p_retry_seconds INTEGER DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_rows  INTEGER;
  v_retry INTERVAL := make_interval(secs => COALESCE(p_retry_seconds, LEAST(3600, 30 * power(2, LEAST(p_generation, 7)))::INTEGER));
BEGIN
  IF p_table = 'webhook_inbox' THEN
    UPDATE public.webhook_inbox
    SET publish_state = CASE WHEN p_published THEN 'published' ELSE 'failed' END,
        publish_lease_until = NULL,
        next_publish_at = CASE WHEN p_published THEN next_publish_at ELSE NOW() + v_retry END,
        last_error = CASE WHEN p_published THEN last_error ELSE left(p_error, 2000) END
    WHERE id = p_id AND publish_generation = p_generation AND publish_state <> 'published';
  ELSIF p_table = 'job_queue' THEN
    UPDATE public.job_queue
    SET publish_state = CASE WHEN p_published THEN 'published' ELSE 'failed' END,
        publish_lease_until = NULL,
        next_publish_at = CASE WHEN p_published THEN next_publish_at ELSE NOW() + v_retry END,
        last_error = CASE WHEN p_published THEN last_error ELSE left(p_error, 2000) END
    WHERE id = p_id AND publish_generation = p_generation AND publish_state <> 'published';
  ELSE
    RAISE EXCEPTION 'complete_publication: unsupported table %', p_table;
  END IF;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$$;

-- ── Bounded cleanup ────────────────────────────────────────────────────────
-- Each statement touches at most p_limit rows; the daily job repeats until
-- the backlog drains. Unresolved work (pending, processing, suspended,
-- uncertain jobs; unprocessed inbox rows) is never removed. Processed inbox
-- rows lose their payload after 7 days but keep the event key as a dedupe
-- tombstone for 30 days, well past Meta's redelivery window.
CREATE OR REPLACE FUNCTION public.cleanup_batch(p_limit INTEGER DEFAULT 1000)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_result JSONB := '{}'::jsonb;
  v_rows   INTEGER;
BEGIN
  UPDATE public.webhook_inbox SET payload = '{}'::jsonb
  WHERE id IN (
    SELECT id FROM public.webhook_inbox
    WHERE state IN ('processed', 'ignored') AND payload <> '{}'::jsonb AND received_at < NOW() - INTERVAL '7 days'
    LIMIT p_limit
  );
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_result := v_result || jsonb_build_object('inbox_redacted', v_rows);

  DELETE FROM public.webhook_inbox
  WHERE id IN (
    SELECT id FROM public.webhook_inbox
    WHERE state IN ('processed', 'ignored', 'failed') AND received_at < NOW() - INTERVAL '30 days'
    LIMIT p_limit
  );
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_result := v_result || jsonb_build_object('inbox_deleted', v_rows);

  DELETE FROM public.job_queue
  WHERE id IN (
    SELECT id FROM public.job_queue
    WHERE status IN ('done', 'failed', 'skipped') AND updated_at < NOW() - INTERVAL '7 days'
    LIMIT p_limit
  );
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_result := v_result || jsonb_build_object('jobs_deleted', v_rows);

  DELETE FROM public.debug_events
  WHERE id IN (SELECT id FROM public.debug_events WHERE created_at < NOW() - INTERVAL '7 days' LIMIT p_limit);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_result := v_result || jsonb_build_object('debug_events_deleted', v_rows);

  DELETE FROM public.dm_rate_events
  WHERE id IN (SELECT id FROM public.dm_rate_events WHERE sent_at < NOW() - INTERVAL '2 hours' LIMIT p_limit);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_result := v_result || jsonb_build_object('rate_events_deleted', v_rows);

  DELETE FROM public.automation_sessions
  WHERE id IN (
    SELECT id FROM public.automation_sessions
    WHERE completed = TRUE AND last_activity_at < NOW() - INTERVAL '30 days'
    LIMIT p_limit
  );
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_result := v_result || jsonb_build_object('sessions_deleted', v_rows);

  -- pg_cron is optional here; skip its history when the extension is absent.
  IF to_regclass('cron.job_run_details') IS NOT NULL THEN
    EXECUTE format(
      'DELETE FROM cron.job_run_details WHERE runid IN (SELECT runid FROM cron.job_run_details WHERE end_time < NOW() - INTERVAL ''7 days'' LIMIT %s)',
      p_limit
    );
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_result := v_result || jsonb_build_object('cron_runs_deleted', v_rows);
  END IF;

  RETURN v_result;
END;
$$;

-- ── Privileges ─────────────────────────────────────────────────────────────
REVOKE EXECUTE ON FUNCTION public.try_maintenance_lock(TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.release_maintenance_lock(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cleanup_batch(INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.claim_inbox_publication(INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.claim_job_publication(INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.complete_publication(TEXT, UUID, INTEGER, BOOLEAN, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.try_maintenance_lock(TEXT, TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_maintenance_lock(TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.cleanup_batch(INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_inbox_publication(INTEGER, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_job_publication(INTEGER, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_publication(TEXT, UUID, INTEGER, BOOLEAN, TEXT, INTEGER) TO service_role;
