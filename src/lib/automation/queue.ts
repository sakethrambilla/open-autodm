/**
 * Postgres-native job queue (replaces BullMQ + Redis).
 *
 * Jobs live in the job_queue table. Each job is published by ID to Inngest
 * and claimed by exactly one workflow run through the claim_job RPC, which
 * hands out a versioned lease; every later write is guarded by that lease.
 *
 * Recovery (cron) republishes due rows by ID; it never runs a job itself.
 *
 * Idempotency: dedupe_key is unique - replaying the same stored event can
 * never create a second job; enqueueJob reports the existing job instead.
 */

import { createServiceClient } from '@/lib/supabase/service';
import { createLogger } from '@/lib/logger';
import { debugLog } from '@/lib/debugLog';
import type { AutoDmJobPayload, JobQueueRow } from '@/lib/types';

const logger = createLogger('queue');

/** Retry backoff: 5s → 25s → 125s (matches the original BullMQ config). */
export function retryBackoffMs(attempts: number): number {
  return 5000 * Math.pow(5, Math.max(0, attempts - 1));
}

export type EnqueueResult = { status: 'created'; id: string } | { status: 'duplicate'; id: string };

/**
 * Inserts a job. A dedupe_key collision is a normal outcome and returns the
 * existing job's ID; any other database error is thrown.
 */
export async function enqueueJob(
  jobType: 'auto_dm' | 'follow_up',
  payload: AutoDmJobPayload,
  dedupeKey: string,
  inboxId: string | null = null
): Promise<EnqueueResult> {
  const db = createServiceClient();
  const { data, error } = await db
    .from('job_queue')
    .insert({ job_type: jobType, payload, dedupe_key: dedupeKey, inbox_id: inboxId })
    .select('id')
    .maybeSingle();

  if (!error && data?.id) return { status: 'created', id: data.id as string };

  if (error && error.code !== '23505') {
    logger.error({ err: error, dedupeKey }, 'Failed to enqueue job');
    debugLog('webhook', 'error', 'job_enqueue_error', 'error', `job_queue insert failed: ${error.message}`, {
      dedupeKey,
      error: error.message,
    });
    throw new Error(`job_queue insert failed: ${error.message}`);
  }

  const { data: existing, error: lookupError } = await db
    .from('job_queue')
    .select('id')
    .eq('dedupe_key', dedupeKey)
    .maybeSingle();
  if (lookupError || !existing?.id) {
    throw new Error(`job_queue duplicate lookup failed: ${lookupError?.message ?? 'row not found'}`);
  }
  logger.info({ dedupeKey }, 'Job already exists - duplicate event ignored');
  return { status: 'duplicate', id: existing.id as string };
}

/** Job lease length; dispatch steps renew it, so it only has to cover one step. */
export const JOB_LEASE_SECONDS = 600;

/**
 * Claims one job for a workflow run. Returns null when another run holds it or
 * it is finished. A retried claim step by the same owner gets its lease back.
 */
export async function claimJob(jobId: string, owner: string): Promise<JobQueueRow | null> {
  const db = createServiceClient();
  const { data, error } = await db.rpc('claim_job', { p_job_id: jobId, p_owner: owner, p_lease_seconds: JOB_LEASE_SECONDS });
  if (error) throw new Error(`claim_job RPC failed: ${error.message}`);
  const claimed = ((data ?? []) as JobQueueRow[])[0];
  if (claimed) return claimed;

  const { data: current, error: loadError } = await db.from('job_queue').select('*').eq('id', jobId).maybeSingle();
  if (loadError) throw new Error(`job_queue load failed: ${loadError.message}`);
  const job = current as JobQueueRow | null;
  return job && job.status === 'processing' && job.lease_owner === owner ? job : null;
}

/** Extends this owner's lease. False means the lease was lost and the run must stop. */
export async function renewJobLease(jobId: string, owner: string): Promise<boolean> {
  const db = createServiceClient();
  const { data, error } = await db
    .from('job_queue')
    .update({ lease_expires_at: new Date(Date.now() + JOB_LEASE_SECONDS * 1000).toISOString() })
    .eq('id', jobId)
    .eq('lease_owner', owner)
    .eq('status', 'processing')
    .select('id');
  if (error) throw new Error(`job lease renewal failed for ${jobId}: ${error.message}`);
  return ((data ?? []) as unknown[]).length > 0;
}

/** Releases the lease for a long durable sleep; the run re-claims the job when it wakes. */
export async function suspendJob(jobId: string, owner: string, wakeAt: Date, reason: string): Promise<void> {
  const db = createServiceClient();
  const { error } = await db
    .from('job_queue')
    .update({
      status: 'suspended',
      run_after: new Date(wakeAt.getTime() - 30_000).toISOString(),
      next_retry_at: wakeAt.toISOString(),
      lease_expires_at: null,
      locked_at: null,
      last_error: reason.slice(0, 2000),
    })
    .eq('id', jobId)
    .eq('lease_owner', owner);
  if (error) throw new Error(`suspendJob failed for ${jobId}: ${error.message}`);
}

export type FinalJobStatus = 'done' | 'failed' | 'skipped' | 'uncertain';

/** Records the terminal state. Only the lease owner may finish, unless owner is null (failure hook). */
export async function finishJob(jobId: string, owner: string | null, status: FinalJobStatus, errorMessage: string | null): Promise<void> {
  const db = createServiceClient();
  let query = db
    .from('job_queue')
    .update({
      status,
      lease_expires_at: null,
      locked_at: null,
      next_retry_at: null,
      last_error: errorMessage ? errorMessage.slice(0, 2000) : null,
    })
    .eq('id', jobId);
  if (owner) query = query.eq('lease_owner', owner);
  const { error } = await query;
  if (error) throw new Error(`finishJob failed for ${jobId}: ${error.message}`);
}

export type JobType = JobQueueRow['job_type'];

export interface JobPublicationRef {
  jobId: string;
  instagramAccountId: string;
  generation: number;
  jobType: JobType;
}

/** Of the given jobs, those still waiting for their first job.ready publication. */
export async function unpublishedJobs(jobIds: string[]): Promise<JobPublicationRef[]> {
  if (jobIds.length === 0) return [];
  const db = createServiceClient();
  const { data, error } = await db
    .from('job_queue')
    .select('id, job_type, payload, publish_generation, publish_state, status')
    .in('id', jobIds);
  if (error) throw new Error(`job_queue publication lookup failed: ${error.message}`);
  return ((data ?? []) as Array<Pick<JobQueueRow, 'id' | 'job_type' | 'payload' | 'publish_generation' | 'publish_state' | 'status'>>)
    .filter((j) => j.status === 'pending' && j.publish_state === 'pending')
    .map((j) => ({
      jobId: j.id,
      instagramAccountId: j.payload.instagramAccountId,
      generation: j.publish_generation,
      jobType: j.job_type,
    }));
}

/** Marks one publication attempt done; a stale generation is ignored by the RPC. */
export async function markPublished(table: 'webhook_inbox' | 'job_queue', id: string, generation: number): Promise<void> {
  const db = createServiceClient();
  const { error } = await db.rpc('complete_publication', {
    p_table: table,
    p_id: id,
    p_generation: generation,
    p_published: true,
  });
  if (error) throw new Error(`complete_publication failed for ${table}/${id}: ${error.message}`);
}

export type DuePublication =
  | { table: 'webhook_inbox'; id: string; instagramAccountId: string; generation: number }
  | { table: 'job_queue'; id: string; instagramAccountId: string; generation: number; jobType: JobType };

export interface RecoveryResult {
  requeued: number;
  uncertain: number;
  published: number;
  failed: number;
}

/**
 * One recovery pass: expired leases are reclassified (dispatching sends become
 * uncertain, never resent), then up to `limit` due inbox/job rows are claimed
 * and handed to `publish` in a single call. Nothing due means `publish` is not
 * called. A publish error marks the batch failed with backoff; an accepted
 * publish whose result is lost is reclaimed later, and the duplicate event is
 * absorbed by claim_job and the action dispatch guards.
 */
export async function recoverAndPublish(
  publish: (due: DuePublication[]) => Promise<void>,
  limit = 100
): Promise<RecoveryResult> {
  const db = createServiceClient();
  const { data: recovered, error: recoverError } = await db.rpc('recover_stale_leases');
  if (recoverError) throw new Error(`recover_stale_leases failed: ${recoverError.message}`);
  const counts = ((recovered ?? []) as Array<{ requeued: number; uncertain: number }>)[0] ?? { requeued: 0, uncertain: 0 };

  const { data: inbox, error: inboxError } = await db.rpc('claim_inbox_publication', { p_limit: limit });
  if (inboxError) throw new Error(`claim_inbox_publication failed: ${inboxError.message}`);
  const due: DuePublication[] = ((inbox ?? []) as Array<{ id: string; instagram_account_id: string; publish_generation: number }>)
    .map((r) => ({ table: 'webhook_inbox' as const, id: r.id, instagramAccountId: r.instagram_account_id, generation: r.publish_generation }));

  if (due.length < limit) {
    const { data: jobs, error: jobError } = await db.rpc('claim_job_publication', { p_limit: limit - due.length });
    if (jobError) throw new Error(`claim_job_publication failed: ${jobError.message}`);
    for (const r of (jobs ?? []) as Array<{ id: string; instagram_account_id: string; publish_generation: number; job_type: JobType }>) {
      due.push({ table: 'job_queue', id: r.id, instagramAccountId: r.instagram_account_id, generation: r.publish_generation, jobType: r.job_type });
    }
  }

  const result: RecoveryResult = { ...counts, published: 0, failed: 0 };
  if (due.length === 0) return result;

  try {
    await publish(due);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await Promise.all(due.map((d) => markPublicationFailed(d, message)));
    logger.warn({ err, count: due.length }, 'Recovery publication failed');
    return { ...result, failed: due.length };
  }
  await Promise.all(due.map((d) => markPublished(d.table, d.id, d.generation)));
  return { ...result, published: due.length };
}

async function markPublicationFailed(d: DuePublication, message: string): Promise<void> {
  const db = createServiceClient();
  const { error } = await db.rpc('complete_publication', {
    p_table: d.table,
    p_id: d.id,
    p_generation: d.generation,
    p_published: false,
    p_error: message,
  });
  if (error) throw new Error(`complete_publication failed for ${d.table}/${d.id}: ${error.message}`);
}
