-- Durable webhook inbox, job outbox extensions, per-send action ledger and
-- service-only RPCs. Additive: earlier migrations are not edited.

-- ── webhook_inbox ──────────────────────────────────────────────────────────
CREATE TABLE public.webhook_inbox (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  instagram_account_id  UUID        NOT NULL REFERENCES public.instagram_accounts(id) ON DELETE CASCADE,
  -- Stable per-account provider key, e.g. comment:<id>, message:<mid>, postback:<mid>.
  event_key             TEXT        NOT NULL,
  event_kind            TEXT        NOT NULL CHECK (event_kind IN ('comment', 'message', 'postback')),
  payload               JSONB       NOT NULL,
  state                 TEXT        NOT NULL DEFAULT 'received'
                          CHECK (state IN ('received', 'processing', 'processed', 'ignored', 'failed')),
  occurred_at           TIMESTAMPTZ,
  received_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  publish_state         TEXT        NOT NULL DEFAULT 'pending'
                          CHECK (publish_state IN ('pending', 'publishing', 'published', 'failed')),
  publish_generation    INTEGER     NOT NULL DEFAULT 0,
  publish_lease_until   TIMESTAMPTZ,
  next_publish_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error            TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (instagram_account_id, event_key)
);

CREATE INDEX idx_webhook_inbox_publish_due ON public.webhook_inbox (next_publish_at)
  WHERE publish_state IN ('pending', 'publishing', 'failed');
CREATE INDEX idx_webhook_inbox_account_received ON public.webhook_inbox (instagram_account_id, received_at DESC);

CREATE TRIGGER webhook_inbox_updated_at
  BEFORE UPDATE ON public.webhook_inbox
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

ALTER TABLE public.webhook_inbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.webhook_inbox FROM anon, authenticated;

-- ── job_queue extensions ───────────────────────────────────────────────────
ALTER TABLE public.job_queue
  ADD COLUMN inbox_id            UUID        REFERENCES public.webhook_inbox(id) ON DELETE SET NULL,
  ADD COLUMN workflow_run_id     TEXT,
  ADD COLUMN publish_state       TEXT        NOT NULL DEFAULT 'pending'
                                   CHECK (publish_state IN ('pending', 'publishing', 'published', 'failed')),
  ADD COLUMN publish_generation  INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN publish_lease_until TIMESTAMPTZ,
  ADD COLUMN next_publish_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN lease_owner         TEXT,
  ADD COLUMN lease_version       INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN lease_expires_at    TIMESTAMPTZ,
  ADD COLUMN next_retry_at       TIMESTAMPTZ;

ALTER TABLE public.job_queue DROP CONSTRAINT job_queue_status_check;
ALTER TABLE public.job_queue ADD CONSTRAINT job_queue_status_check
  CHECK (status IN ('pending', 'processing', 'suspended', 'done', 'failed', 'skipped', 'uncertain'));

CREATE INDEX idx_job_queue_publish_due ON public.job_queue (next_publish_at)
  WHERE publish_state IN ('pending', 'publishing', 'failed');
CREATE INDEX idx_job_queue_lease_expiry ON public.job_queue (lease_expires_at)
  WHERE status = 'processing';
CREATE INDEX idx_job_queue_retry_due ON public.job_queue (next_retry_at)
  WHERE next_retry_at IS NOT NULL;
CREATE INDEX idx_job_queue_account ON public.job_queue ((payload->>'instagramAccountId'), created_at DESC);

REVOKE ALL ON public.job_queue FROM anon, authenticated;

-- ── outbound_actions ───────────────────────────────────────────────────────
CREATE TABLE public.outbound_actions (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                UUID        NOT NULL REFERENCES public.job_queue(id) ON DELETE CASCADE,
  instagram_account_id  UUID        NOT NULL REFERENCES public.instagram_accounts(id) ON DELETE CASCADE,
  action_key            TEXT        NOT NULL,
  action_kind           TEXT        NOT NULL CHECK (action_kind IN ('public_reply', 'private_reply', 'dm')),
  recipient_ref         TEXT        NOT NULL,
  -- Immutable once inserted: a retry sends exactly what was planned.
  message_snapshot      JSONB       NOT NULL,
  state                 TEXT        NOT NULL DEFAULT 'pending'
                          CHECK (state IN ('pending', 'dispatching', 'accepted', 'skipped', 'failed', 'uncertain')),
  provider_message_id   TEXT,
  dispatched_at         TIMESTAMPTZ,
  next_attempt_at       TIMESTAMPTZ,
  error_class           TEXT,
  last_error            TEXT,
  attempts              INTEGER     NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (job_id, action_key)
);

CREATE INDEX idx_outbound_actions_account_state ON public.outbound_actions (instagram_account_id, state, updated_at DESC);
CREATE INDEX idx_outbound_actions_dispatching ON public.outbound_actions (dispatched_at) WHERE state = 'dispatching';

CREATE TRIGGER outbound_actions_updated_at
  BEFORE UPDATE ON public.outbound_actions
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

CREATE OR REPLACE FUNCTION public.outbound_actions_freeze_snapshot()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.message_snapshot IS DISTINCT FROM OLD.message_snapshot THEN
    RAISE EXCEPTION 'outbound_actions.message_snapshot is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER outbound_actions_snapshot_immutable
  BEFORE UPDATE ON public.outbound_actions
  FOR EACH ROW EXECUTE FUNCTION public.outbound_actions_freeze_snapshot();

ALTER TABLE public.outbound_actions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.outbound_actions FROM anon, authenticated;

-- ── RPC: publication claims (inbox + job outbox) ───────────────────────────
-- Claims due rows and bumps their generation so each publish attempt has a
-- distinct, stable idempotency key (id + generation).
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
      AND (x.publish_state IN ('pending', 'failed')
           OR (x.publish_state = 'publishing' AND x.publish_lease_until < NOW()))
    ORDER BY x.next_publish_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  RETURNING wi.id, wi.instagram_account_id, wi.publish_generation;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_job_publication(p_limit INTEGER DEFAULT 100, p_lease_seconds INTEGER DEFAULT 120)
RETURNS TABLE (id UUID, instagram_account_id TEXT, publish_generation INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  UPDATE public.job_queue jq
  SET publish_state = 'publishing',
      publish_generation = jq.publish_generation + 1,
      publish_lease_until = NOW() + make_interval(secs => p_lease_seconds)
  WHERE jq.id IN (
    SELECT x.id FROM public.job_queue x
    WHERE x.status = 'pending'
      AND x.next_publish_at <= NOW()
      AND (x.publish_state IN ('pending', 'failed')
           OR (x.publish_state = 'publishing' AND x.publish_lease_until < NOW()))
    ORDER BY x.next_publish_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  RETURNING jq.id, jq.payload->>'instagramAccountId', jq.publish_generation;
END;
$$;

-- Records the outcome of one publish attempt; stale generations are ignored.
CREATE OR REPLACE FUNCTION public.complete_publication(
  p_table       TEXT,
  p_id          UUID,
  p_generation  INTEGER,
  p_published   BOOLEAN,
  p_error       TEXT DEFAULT NULL,
  p_retry_seconds INTEGER DEFAULT 300
)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_rows INTEGER;
BEGIN
  IF p_table = 'webhook_inbox' THEN
    UPDATE public.webhook_inbox
    SET publish_state = CASE WHEN p_published THEN 'published' ELSE 'failed' END,
        publish_lease_until = NULL,
        next_publish_at = CASE WHEN p_published THEN next_publish_at ELSE NOW() + make_interval(secs => p_retry_seconds) END,
        last_error = CASE WHEN p_published THEN last_error ELSE left(p_error, 2000) END
    WHERE id = p_id AND publish_generation = p_generation AND publish_state <> 'published';
  ELSIF p_table = 'job_queue' THEN
    UPDATE public.job_queue
    SET publish_state = CASE WHEN p_published THEN 'published' ELSE 'failed' END,
        publish_lease_until = NULL,
        next_publish_at = CASE WHEN p_published THEN next_publish_at ELSE NOW() + make_interval(secs => p_retry_seconds) END,
        last_error = CASE WHEN p_published THEN last_error ELSE left(p_error, 2000) END
    WHERE id = p_id AND publish_generation = p_generation AND publish_state <> 'published';
  ELSE
    RAISE EXCEPTION 'complete_publication: unsupported table %', p_table;
  END IF;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$$;

-- ── RPC: single-job claim with a versioned lease ───────────────────────────
-- Returns no row when the job is not claimable (already leased, finished or
-- not yet due), so duplicate runs are rejected by the database.
CREATE OR REPLACE FUNCTION public.claim_job(p_job_id UUID, p_owner TEXT, p_lease_seconds INTEGER DEFAULT 300)
RETURNS SETOF public.job_queue
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  UPDATE public.job_queue
  SET status = 'processing',
      locked_at = NOW(),
      lease_owner = p_owner,
      lease_version = lease_version + 1,
      lease_expires_at = NOW() + make_interval(secs => p_lease_seconds)
  WHERE id = p_job_id
    AND (status IN ('pending', 'suspended')
         OR (status = 'processing' AND lease_expires_at < NOW()))
    AND run_after <= NOW()
  RETURNING *;
END;
$$;

-- ── RPC: action dispatch transitions ───────────────────────────────────────
-- pending → dispatching. Returns false when the action is not pending, which
-- means another run already dispatched (or finished) it: do not send.
CREATE OR REPLACE FUNCTION public.begin_action_dispatch(p_action_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_rows INTEGER;
BEGIN
  UPDATE public.outbound_actions
  SET state = 'dispatching', dispatched_at = NOW(), attempts = attempts + 1, next_attempt_at = NULL
  WHERE id = p_action_id
    AND state = 'pending'
    AND (next_attempt_at IS NULL OR next_attempt_at <= NOW());
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$$;

-- dispatching → accepted | failed | uncertain | skipped | pending (explicit
-- retryable rejection only, with p_retry_at). Accepted actions never change.
CREATE OR REPLACE FUNCTION public.complete_action_dispatch(
  p_action_id           UUID,
  p_state               TEXT,
  p_provider_message_id TEXT DEFAULT NULL,
  p_error_class         TEXT DEFAULT NULL,
  p_error               TEXT DEFAULT NULL,
  p_retry_at            TIMESTAMPTZ DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_rows INTEGER;
BEGIN
  IF p_state NOT IN ('accepted', 'failed', 'uncertain', 'skipped', 'pending') THEN
    RAISE EXCEPTION 'complete_action_dispatch: invalid state %', p_state;
  END IF;
  IF p_state = 'pending' AND p_retry_at IS NULL THEN
    RAISE EXCEPTION 'complete_action_dispatch: pending requires p_retry_at';
  END IF;

  UPDATE public.outbound_actions
  SET state = p_state,
      provider_message_id = COALESCE(p_provider_message_id, provider_message_id),
      error_class = p_error_class,
      last_error = left(p_error, 2000),
      next_attempt_at = CASE WHEN p_state = 'pending' THEN p_retry_at ELSE NULL END
  WHERE id = p_action_id AND state = 'dispatching';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$$;

-- ── RPC: stale lease recovery ──────────────────────────────────────────────
-- Expired job leases: jobs with an action stuck in dispatching become
-- uncertain (that action too); others return to pending for republication.
-- Never makes a dispatched send eligible to run again.
CREATE OR REPLACE FUNCTION public.recover_stale_leases(p_dispatch_timeout_seconds INTEGER DEFAULT 300)
RETURNS TABLE (requeued INTEGER, uncertain INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_requeued  INTEGER;
  v_uncertain INTEGER;
BEGIN
  UPDATE public.outbound_actions oa
  SET state = 'uncertain', error_class = 'dispatch_interrupted'
  WHERE oa.state = 'dispatching'
    AND oa.dispatched_at < NOW() - make_interval(secs => p_dispatch_timeout_seconds)
    AND EXISTS (
      SELECT 1 FROM public.job_queue jq
      WHERE jq.id = oa.job_id
        AND (jq.status <> 'processing' OR jq.lease_expires_at IS NULL OR jq.lease_expires_at < NOW())
    );

  UPDATE public.job_queue jq
  SET status = 'uncertain', lease_owner = NULL, lease_expires_at = NULL, locked_at = NULL
  WHERE jq.status = 'processing'
    AND jq.lease_expires_at < NOW()
    AND EXISTS (SELECT 1 FROM public.outbound_actions oa WHERE oa.job_id = jq.id AND oa.state IN ('uncertain', 'dispatching'));
  GET DIAGNOSTICS v_uncertain = ROW_COUNT;

  UPDATE public.job_queue jq
  SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL, locked_at = NULL,
      publish_state = 'pending', next_publish_at = NOW()
  WHERE jq.status = 'processing'
    AND jq.lease_expires_at < NOW();
  GET DIAGNOSTICS v_requeued = ROW_COUNT;

  RETURN QUERY SELECT v_requeued, v_uncertain;
END;
$$;

-- ── Privileges ─────────────────────────────────────────────────────────────
-- SECURITY DEFINER bypasses RLS, so EXECUTE must be restricted explicitly.
-- Existing service-only RPCs are tightened here as well (they default to PUBLIC).
REVOKE EXECUTE ON FUNCTION public.claim_inbox_publication(INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.claim_job_publication(INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.complete_publication(TEXT, UUID, INTEGER, BOOLEAN, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.claim_job(UUID, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.begin_action_dispatch(UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.complete_action_dispatch(UUID, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.recover_stale_leases(INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.outbound_actions_freeze_snapshot() FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.claim_due_jobs(INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.check_and_record_dm_rate_limit(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cleanup_old_rows() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.record_contact_interaction(UUID, TEXT, TEXT, TEXT, UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.update_contact_profile(UUID, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.increment_automation_dms_sent(UUID) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_inbox_publication(INTEGER, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_job_publication(INTEGER, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_publication(TEXT, UUID, INTEGER, BOOLEAN, TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_job(UUID, TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.begin_action_dispatch(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_action_dispatch(UUID, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION public.recover_stale_leases(INTEGER) TO service_role;
