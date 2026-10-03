/**
 * Debug panel API - recent automation events plus durable-processing state.
 * GET    → newest 200 events and the owner's failed/uncertain/delayed inbox,
 *          job and outbound-action rows (no payloads, message snapshots or tokens)
 * DELETE → clear the log
 *
 * Auth-gated (your own instance, your own logs) and additionally hidden in
 * the UI unless NEXT_PUBLIC_DEBUG=true.
 */

import { getAuthenticatedUser, unauthorized } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROW_LIMIT = 50;
const DELAY_GRACE_MS = 10 * 60_000;
const ERROR_MAX_CHARS = 300;

const INBOX_COLUMNS =
  'id, instagram_account_id, event_kind, state, publish_state, publish_generation, next_publish_at, last_error, received_at, updated_at';
const JOB_COLUMNS =
  'id, job_type, status, publish_state, publish_generation, run_after, next_retry_at, lease_expires_at, last_error, workflow_run_id, inbox_id, updated_at';
const ACTION_COLUMNS =
  'id, job_id, instagram_account_id, action_kind, state, error_class, last_error, attempts, dispatched_at, next_attempt_at, provider_message_id, updated_at';

type Row = Record<string, unknown>;

function trimErrors(rows: Row[] | null): Row[] {
  return (rows ?? []).map((r) =>
    typeof r['last_error'] === 'string' ? { ...r, last_error: r['last_error'].slice(0, ERROR_MAX_CHARS) } : r,
  );
}

export async function GET(request: Request): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();

  const db = createServiceClient();
  const { data, error } = await db
    .from('debug_events')
    .select('id, created_at, service, level, event_type, status, message, metadata')
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) {
    return Response.json({ error: 'Failed to fetch debug events' }, { status: 500 });
  }

  const { data: accounts, error: accountsError } = await db
    .from('instagram_accounts')
    .select('id')
    .eq('user_id', user.id);
  if (accountsError) {
    return Response.json({ error: 'Failed to fetch accounts' }, { status: 500 });
  }
  const accountIds = (accounts ?? []).map((a: { id: string }) => a.id);
  if (accountIds.length === 0) {
    return Response.json({ events: data ?? [], inbox: [], jobs: [], actions: [] });
  }

  const delayedBefore = new Date(Date.now() - DELAY_GRACE_MS).toISOString();
  const [inbox, jobs, actions] = await Promise.all([
    db.from('webhook_inbox')
      .select(INBOX_COLUMNS)
      .in('instagram_account_id', accountIds)
      .or(`state.eq.failed,publish_state.eq.failed,and(state.eq.received,next_publish_at.lt.${delayedBefore})`)
      .order('updated_at', { ascending: false })
      .limit(ROW_LIMIT),
    db.from('job_queue')
      .select(JOB_COLUMNS)
      .in('payload->>instagramAccountId', accountIds)
      .or(`status.in.(failed,uncertain,suspended),publish_state.eq.failed,and(status.eq.pending,run_after.lt.${delayedBefore})`)
      .order('updated_at', { ascending: false })
      .limit(ROW_LIMIT),
    db.from('outbound_actions')
      .select(ACTION_COLUMNS)
      .in('instagram_account_id', accountIds)
      .order('updated_at', { ascending: false })
      .limit(ROW_LIMIT),
  ]);
  if (inbox.error || jobs.error || actions.error) {
    return Response.json({ error: 'Failed to fetch processing state' }, { status: 500 });
  }

  return Response.json({
    events: data ?? [],
    inbox: trimErrors(inbox.data as Row[] | null),
    jobs: trimErrors(jobs.data as Row[] | null),
    actions: trimErrors(actions.data as Row[] | null),
  });
}

export async function DELETE(request: Request): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();

  const db = createServiceClient();
  const { error } = await db.from('debug_events').delete().gte('created_at', '1970-01-01');
  if (error) {
    return Response.json({ error: 'Failed to clear debug events' }, { status: 500 });
  }
  return Response.json({ success: true });
}
