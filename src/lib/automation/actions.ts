/**
 * Outbound actions - one row per planned send (public reply, opening DM,
 * response), each with a stable action_key and an immutable message snapshot.
 *
 * dispatchAction is the only place that calls Meta. It re-checks policy
 * immediately before the send, persists the dispatch marker first, and maps
 * the result onto the ambiguous-outcome rule: anything that may have been
 * delivered becomes uncertain and is never resent automatically.
 */

import { createServiceClient } from '@/lib/supabase/service';
import { createLogger } from '@/lib/logger';
import { debugLog } from '@/lib/debugLog';
import { decrypt } from '@/lib/crypto';
import { getEnv } from '@/lib/env';
import { renewJobLease } from '@/lib/automation/queue';
import { classifySendError } from '@/lib/automation/engine';
import {
  sendInstagramDm,
  sendInstagramLinkButtonDm,
  sendInstagramCardDm,
  sendAskToFollowDm,
  replyToComment,
  type DmRecipient,
  type QuickReply,
} from '@/lib/instagram/api';
import { MetaApiError, AccountPausedMetaError } from '@/lib/instagram/errors';
import type { InstagramAccountRow, JobQueueRow, OutboundActionRow } from '@/lib/types';

const logger = createLogger('actions');

/** Hourly DM cap per account (Meta hard limit is 200; 20-DM safety buffer). */
export const DM_LIMIT_PER_HOUR = 180;

export type SendSpec =
  | { type: 'comment_reply'; commentId: string; text: string }
  | { type: 'text'; recipient: DmRecipient; text: string; quickReply?: QuickReply }
  | { type: 'link'; recipient: DmRecipient; text: string; buttonTitle: string; url: string }
  | {
      type: 'card';
      recipientId: string;
      card: { imageUrl?: string; title?: string; subtitle?: string; buttons?: { title: string; url: string }[] };
    }
  | {
      type: 'ask_follow';
      recipientId: string;
      options: { message: string; creatorUsername: string; visitProfileButtonTitle: string; confirmButtonTitle: string; confirmPayload: string };
    };

export type SessionEffect = 'none' | 'advance' | 'touch' | 'complete';

export interface ActionSnapshot {
  send: SendSpec;
  /** An explicit rejection skips this action instead of halting the flow. */
  bestEffort: boolean;
  countsTowardRate: boolean;
  logText: string;
  session: { id: string; step: number; effect: SessionEffect } | null;
}

export interface PlannedAction {
  key: string;
  snapshot: ActionSnapshot;
}

export interface ActionRef {
  id: string;
  key: string;
}

export type ActionRow = Omit<OutboundActionRow, 'message_snapshot'> & { message_snapshot: ActionSnapshot };

function actionKind(send: SendSpec): 'public_reply' | 'private_reply' | 'dm' {
  if (send.type === 'comment_reply') return 'public_reply';
  if ((send.type === 'text' || send.type === 'link') && 'commentId' in send.recipient) return 'private_reply';
  return 'dm';
}

function recipientRef(send: SendSpec): string {
  if (send.type === 'comment_reply') return send.commentId;
  if (send.type === 'text' || send.type === 'link') {
    return 'commentId' in send.recipient ? send.recipient.commentId : send.recipient.id;
  }
  return send.recipientId;
}

/** Actions already planned for a job, in send order (keys sort by position). */
export async function loadActions(jobId: string): Promise<ActionRow[]> {
  const db = createServiceClient();
  const { data, error } = await db.from('outbound_actions').select('*').eq('job_id', jobId);
  if (error) throw new Error(`outbound_actions load failed: ${error.message}`);
  return ((data ?? []) as ActionRow[]).sort((a, b) => a.action_key.localeCompare(b.action_key));
}

/** Inserts the plan once; a replayed plan keeps the original snapshots. */
export async function persistActions(job: JobQueueRow, planned: PlannedAction[]): Promise<ActionRef[]> {
  const db = createServiceClient();
  const rows = planned.map((p) => ({
    job_id: job.id,
    instagram_account_id: job.payload.instagramAccountId,
    action_key: p.key,
    action_kind: actionKind(p.snapshot.send),
    recipient_ref: recipientRef(p.snapshot.send),
    message_snapshot: p.snapshot,
  }));
  const { error } = await db.from('outbound_actions').upsert(rows, { onConflict: 'job_id,action_key', ignoreDuplicates: true });
  if (error) throw new Error(`outbound_actions insert failed: ${error.message}`);
  return (await loadActions(job.id)).map((a) => ({ id: a.id, key: a.action_key }));
}

/** Opens the circuit breaker: pause all sends for this account. */
export async function pauseAccount(accountId: string, reason: string, hours = 24): Promise<void> {
  const db = createServiceClient();
  const until = new Date(Date.now() + hours * 3600_000).toISOString();
  const { error } = await db
    .from('instagram_accounts')
    .update({ paused_until: until, pause_reason: reason.slice(0, 500) })
    .eq('id', accountId);
  if (error) logger.error({ err: error, accountId }, 'Failed to pause account');
  debugLog('worker', 'error', 'circuit_breaker', 'error',
    `CIRCUIT BREAKER OPENED - account paused for ${hours}h: ${reason}`,
    { accountId, pausedUntil: until });
}

export type DispatchResult =
  | { state: 'accepted' | 'skipped' | 'failed' | 'uncertain'; halt: boolean; reason: string | null }
  | { state: 'wait'; halt: false; waitUntil: string; reason: string }
  | { state: 'lost'; halt: true; reason: string };

function settled(action: ActionRow): DispatchResult {
  const state = action.state as 'accepted' | 'skipped' | 'failed' | 'uncertain';
  const halt = state === 'uncertain' || state === 'skipped' || (state === 'failed' && !action.message_snapshot.bestEffort);
  return { state, halt, reason: action.last_error };
}

async function skipAction(actionId: string, reason: string): Promise<DispatchResult> {
  const db = createServiceClient();
  const { error } = await db
    .from('outbound_actions')
    .update({ state: 'skipped', error_class: 'policy', last_error: reason })
    .eq('id', actionId)
    .eq('state', 'pending');
  if (error) throw new Error(`outbound_actions skip failed: ${error.message}`);
  debugLog('worker', 'info', 'action_skipped', 'skipped', `Send skipped before dispatch: ${reason}`, { actionId });
  return { state: 'skipped', halt: true, reason };
}

async function completeDispatch(
  actionId: string,
  state: 'accepted' | 'failed' | 'uncertain' | 'pending',
  fields: { providerMessageId?: string; errorClass?: string; error?: string; retryAt?: Date }
): Promise<boolean> {
  const db = createServiceClient();
  const { data, error } = await db.rpc('complete_action_dispatch', {
    p_action_id: actionId,
    p_state: state,
    p_provider_message_id: fields.providerMessageId ?? null,
    p_error_class: fields.errorClass ?? null,
    p_error: fields.error ?? null,
    p_retry_at: fields.retryAt?.toISOString() ?? null,
  });
  if (error) throw new Error(`complete_action_dispatch failed for ${actionId}: ${error.message}`);
  return data === true;
}

async function loadAction(actionId: string): Promise<ActionRow> {
  const db = createServiceClient();
  const { data, error } = await db.from('outbound_actions').select('*').eq('id', actionId).maybeSingle();
  if (error || !data) throw new Error(`outbound_actions load failed for ${actionId}: ${error?.message ?? 'not found'}`);
  return data as ActionRow;
}

/** Returns a skip reason, a wait-until time, or null when the send may proceed. */
async function checkPolicy(
  job: Pick<JobQueueRow, 'payload'>,
  action: ActionRow,
  account: InstagramAccountRow | null
): Promise<{ skip: string } | { waitUntil: Date; reason: string } | null> {
  const db = createServiceClient();
  if (!account?.is_active) return { skip: 'Instagram account inactive or disconnected' };
  if (account.paused_until && new Date(account.paused_until).getTime() > Date.now()) {
    return {
      waitUntil: new Date(new Date(account.paused_until).getTime() + 60_000),
      reason: `Account paused by circuit breaker (${account.pause_reason ?? 'policy block'})`,
    };
  }

  const { data: automation, error: automationError } = await db
    .from('automations')
    .select('id')
    .eq('id', job.payload.automationId)
    .eq('is_active', true)
    .maybeSingle();
  if (automationError) throw new Error(`automation lookup failed: ${automationError.message}`);
  if (!automation) return { skip: 'Automation inactive or deleted' };

  const session = action.message_snapshot.session;
  if (session) {
    const { data: row, error: sessionError } = await db
      .from('automation_sessions')
      .select('id, completed, expires_at')
      .eq('id', session.id)
      .maybeSingle();
    if (sessionError) throw new Error(`session lookup failed: ${sessionError.message}`);
    const s = row as { completed: boolean; expires_at: string } | null;
    if (!s || s.completed || new Date(s.expires_at).getTime() < Date.now()) return { skip: 'Session no longer active' };
  }

  if (action.message_snapshot.countsTowardRate) {
    const { data, error } = await db.rpc('check_and_record_dm_rate_limit', {
      p_account_id: account.id,
      p_limit: DM_LIMIT_PER_HOUR,
    });
    if (error) {
      // Fail open with a warning - better to send than silently drop on a DB blip
      logger.error({ err: error, accountId: account.id }, 'Rate limiter RPC error - allowing send');
    } else {
      const row = (data as Array<{ allowed: boolean; current_count: number; retry_after_seconds: number }> | null)?.[0];
      if (row && !row.allowed) {
        debugLog('worker', 'warn', 'rate_limit_check', 'skipped',
          `Rate limit reached (${row.current_count}/${DM_LIMIT_PER_HOUR}/h) - delaying ${Math.ceil(row.retry_after_seconds / 60)}min`,
          { accountId: account.id, currentCount: row.current_count });
        return { waitUntil: new Date(Date.now() + row.retry_after_seconds * 1000), reason: 'Hourly DM limit reached' };
      }
    }
  }
  return null;
}

async function send(spec: SendSpec, igAccountIgsid: string, accessToken: string): Promise<string> {
  switch (spec.type) {
    case 'comment_reply':
      return replyToComment(spec.commentId, spec.text, accessToken);
    case 'text':
      return sendInstagramDm(igAccountIgsid, spec.recipient, spec.text, accessToken, spec.quickReply);
    case 'card':
      return sendInstagramCardDm(igAccountIgsid, spec.recipientId, accessToken, spec.card);
    case 'ask_follow':
      return sendAskToFollowDm(igAccountIgsid, spec.recipientId, accessToken, spec.options);
    case 'link':
      try {
        return await sendInstagramLinkButtonDm(igAccountIgsid, spec.recipient, spec.text, spec.buttonTitle, spec.url, accessToken);
      } catch (err) {
        // Only an explicit template rejection proves nothing was delivered; a policy block must open the breaker.
        if (!(err instanceof MetaApiError) || err instanceof AccountPausedMetaError) throw err;
        debugLog('worker', 'warn', 'link_fallback', 'processing', 'Link button rejected - falling back to inline link', {});
        return sendInstagramDm(igAccountIgsid, spec.recipient, `${spec.text}\n\n${spec.buttonTitle}: ${spec.url}`, accessToken);
      }
  }
}

/**
 * Dispatches one action at most once. Safe to call repeatedly: a settled
 * action returns its stored outcome and one found mid-dispatch (crash or lost
 * step result) becomes uncertain instead of being sent again.
 */
export async function dispatchAction(jobId: string, owner: string, actionId: string): Promise<DispatchResult> {
  if (!(await renewJobLease(jobId, owner))) return { state: 'lost', halt: true, reason: 'Job lease lost' };
  const db = createServiceClient();

  const action = await loadAction(actionId);
  if (action.state === 'dispatching') {
    await completeDispatch(actionId, 'uncertain', { errorClass: 'dispatch_interrupted', error: 'Dispatch interrupted before its outcome was recorded' });
    return settled(await loadAction(actionId));
  }
  if (action.state !== 'pending') return settled(action);
  if (action.next_attempt_at && new Date(action.next_attempt_at).getTime() > Date.now()) {
    return { state: 'wait', halt: false, waitUntil: action.next_attempt_at, reason: action.last_error ?? 'Retry scheduled' };
  }

  const { data: jobRow, error: jobError } = await db.from('job_queue').select('payload').eq('id', jobId).maybeSingle();
  if (jobError || !jobRow) throw new Error(`job_queue load failed for ${jobId}: ${jobError?.message ?? 'not found'}`);
  const job = jobRow as Pick<JobQueueRow, 'payload'>;

  const { data: accountRow, error: accountError } = await db
    .from('instagram_accounts')
    .select('*')
    .eq('id', job.payload.instagramAccountId)
    .maybeSingle();
  if (accountError) throw new Error(`instagram_accounts lookup failed: ${accountError.message}`);
  const account = accountRow as InstagramAccountRow | null;

  const policy = await checkPolicy(job, action, account);
  if (policy && 'skip' in policy) return skipAction(actionId, policy.skip);
  if (policy) return { state: 'wait', halt: false, waitUntil: policy.waitUntil.toISOString(), reason: policy.reason };

  const env = getEnv();
  const accessToken = decrypt(account!.access_token_encrypted, env.TOKEN_ENCRYPTION_KEY);

  const { data: begun, error: beginError } = await db.rpc('begin_action_dispatch', { p_action_id: actionId });
  if (beginError) throw new Error(`begin_action_dispatch failed for ${actionId}: ${beginError.message}`);
  if (begun !== true) return settled(await loadAction(actionId));

  if (env.AUTODM_DRY_RUN) {
    debugLog('worker', 'info', 'dry_run', 'skipped', `Dry run - ${action.action_kind} not sent`, { actionId });
    await completeDispatch(actionId, 'accepted', { providerMessageId: `dry-run:${actionId}` });
    return { state: 'accepted', halt: false, reason: null };
  }

  let messageId: string;
  try {
    messageId = await send(action.message_snapshot.send, job.payload.igAccountIgsid, accessToken);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const outcome = classifySendError(err, action.attempts + 1);
    if (outcome.errorClass === 'account_paused' && err instanceof MetaApiError) {
      await pauseAccount(account!.id, `Meta policy block (code ${err.code}${err.subcode ? `/${err.subcode}` : ''}): ${message}`);
    }
    await completeDispatch(actionId, outcome.state, {
      errorClass: outcome.errorClass,
      error: message,
      ...(outcome.state === 'pending' ? { retryAt: outcome.retryAt } : {}),
    });
    if (outcome.state === 'pending') {
      return { state: 'wait', halt: false, waitUntil: outcome.retryAt.toISOString(), reason: message };
    }
    return settled(await loadAction(actionId));
  }

  if (!(await completeDispatch(actionId, 'accepted', { providerMessageId: messageId }))) {
    return settled(await loadAction(actionId));
  }
  return { state: 'accepted', halt: false, reason: null };
}
