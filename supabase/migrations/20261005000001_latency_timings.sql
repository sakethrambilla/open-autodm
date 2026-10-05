-- Per-request latency stamps (button tap / comment → reply), read through public.request_latency.
-- Stage stamps are set by triggers so the hot path pays no extra round-trips.

ALTER TABLE public.webhook_inbox
  ADD COLUMN request_received_at TIMESTAMPTZ,
  ADD COLUMN processed_at        TIMESTAMPTZ,
  ADD COLUMN fast_path           BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.job_queue
  ADD COLUMN published_at     TIMESTAMPTZ,
  ADD COLUMN first_claimed_at TIMESTAMPTZ,
  ADD COLUMN finished_at      TIMESTAMPTZ;

ALTER TABLE public.outbound_actions
  ADD COLUMN accepted_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION public.stamp_webhook_inbox_timings()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.state = 'processed' AND NEW.processed_at IS NULL THEN
    NEW.processed_at := clock_timestamp();
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.stamp_job_queue_timings()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.publish_state = 'published' AND NEW.published_at IS NULL THEN
    NEW.published_at := clock_timestamp();
  END IF;
  IF NEW.status = 'processing' AND NEW.first_claimed_at IS NULL THEN
    NEW.first_claimed_at := clock_timestamp();
  END IF;
  IF NEW.status IN ('done', 'failed', 'skipped', 'uncertain') AND OLD.status IS DISTINCT FROM NEW.status THEN
    NEW.finished_at := clock_timestamp();
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.stamp_outbound_action_timings()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.state = 'accepted' AND NEW.accepted_at IS NULL THEN
    NEW.accepted_at := clock_timestamp();
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER webhook_inbox_stamp_timings
  BEFORE UPDATE ON public.webhook_inbox
  FOR EACH ROW EXECUTE FUNCTION public.stamp_webhook_inbox_timings();

CREATE TRIGGER job_queue_stamp_timings
  BEFORE UPDATE ON public.job_queue
  FOR EACH ROW EXECUTE FUNCTION public.stamp_job_queue_timings();

CREATE TRIGGER outbound_actions_stamp_timings
  BEFORE UPDATE ON public.outbound_actions
  FOR EACH ROW EXECUTE FUNCTION public.stamp_outbound_action_timings();

REVOKE EXECUTE ON FUNCTION public.stamp_webhook_inbox_timings() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.stamp_job_queue_timings() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.stamp_outbound_action_timings() FROM PUBLIC, anon, authenticated;

-- One row per job. All *_ms columns are milliseconds; NULL means the stage has not happened.
-- meta_delivery_ms compares Meta's event time with our clock, so expect some skew.
CREATE VIEW public.request_latency AS
WITH sends AS (
  SELECT job_id, MIN(accepted_at) AS first_sent_at, MAX(accepted_at) AS last_sent_at, COUNT(accepted_at) AS sends
  FROM public.outbound_actions
  GROUP BY job_id
)
SELECT
  jq.id                                  AS job_id,
  jq.job_type,
  jq.status,
  wi.id                                  AS inbox_id,
  wi.event_kind,
  wi.fast_path,
  jq.payload->>'instagramAccountId'      AS instagram_account_id,
  jq.payload->>'automationId'            AS automation_id,
  wi.occurred_at,
  wi.request_received_at,
  wi.received_at                         AS inbox_stored_at,
  wi.processed_at                        AS inbox_processed_at,
  jq.created_at                          AS job_created_at,
  jq.published_at                        AS job_published_at,
  jq.first_claimed_at                    AS job_claimed_at,
  s.first_sent_at,
  s.last_sent_at,
  jq.finished_at                         AS job_finished_at,
  s.sends,
  (EXTRACT(EPOCH FROM (wi.request_received_at - wi.occurred_at)) * 1000)::INTEGER AS meta_delivery_ms,
  (EXTRACT(EPOCH FROM (wi.received_at - wi.request_received_at)) * 1000)::INTEGER AS inbox_store_ms,
  (EXTRACT(EPOCH FROM (jq.created_at - wi.received_at)) * 1000)::INTEGER          AS match_ms,
  (EXTRACT(EPOCH FROM (jq.published_at - jq.created_at)) * 1000)::INTEGER         AS job_publish_ms,
  (EXTRACT(EPOCH FROM (jq.first_claimed_at - jq.published_at)) * 1000)::INTEGER   AS job_start_ms,
  (EXTRACT(EPOCH FROM (s.first_sent_at - jq.first_claimed_at)) * 1000)::INTEGER   AS claim_to_first_send_ms,
  (EXTRACT(EPOCH FROM (s.last_sent_at - s.first_sent_at)) * 1000)::INTEGER        AS first_to_last_send_ms,
  (EXTRACT(EPOCH FROM (s.first_sent_at - wi.request_received_at)) * 1000)::INTEGER AS received_to_first_send_ms,
  (EXTRACT(EPOCH FROM (s.first_sent_at - wi.occurred_at)) * 1000)::INTEGER        AS event_to_first_send_ms
FROM public.job_queue jq
LEFT JOIN public.webhook_inbox wi ON wi.id = jq.inbox_id
LEFT JOIN sends s ON s.job_id = jq.id;

REVOKE ALL ON public.request_latency FROM anon, authenticated;

-- Recovery republishes job.ready with the job type so runJob can pick the right concurrency lane.
DROP FUNCTION public.claim_job_publication(INTEGER, INTEGER);
CREATE FUNCTION public.claim_job_publication(p_limit INTEGER DEFAULT 100, p_lease_seconds INTEGER DEFAULT 120)
RETURNS TABLE (id UUID, instagram_account_id TEXT, publish_generation INTEGER, job_type TEXT)
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
  RETURNING jq.id, jq.payload->>'instagramAccountId', jq.publish_generation, jq.job_type;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.claim_job_publication(INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_job_publication(INTEGER, INTEGER) TO service_role;
