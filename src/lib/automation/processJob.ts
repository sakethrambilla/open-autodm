/**
 * AutoDM job workflow, split into durable steps:
 *
 *  1. claim     - versioned lease on the job row; duplicate runs get nothing.
 *  2. prepare   - the pre-send checks of the original processors (24h window,
 *                 dedup, active automation/account, sessions, follow check)
 *                 and one outbound_actions row per send with a frozen snapshot.
 *  3. dispatch  - one step per action (see actions.ts); policy is re-checked
 *                 before each send, delays are durable sleeps.
 *  4. finalize  - dm_sent_log, counters, session progress, job status.
 *
 * Safety layers kept from the original processors: the Postgres rate limiter
 * (now counted per DM), human-like jitter as durable sleeps, and the circuit
 * breaker on Meta policy blocks (code 368).
 */

import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createServiceClient } from '@/lib/supabase/service';
import { createLogger } from '@/lib/logger';
import { debugLog } from '@/lib/debugLog';
import { decrypt } from '@/lib/crypto';
import { getEnv } from '@/lib/env';
import type { AutoDmJobPayload, AutomationRow, InstagramAccountRow, DMResponse, JobQueueRow } from '@/lib/types';
import { getAudienceProfile, type DmRecipient } from '@/lib/instagram/api';
import { updateContactProfile } from '@/lib/automation/contacts';
import { renderTemplate } from '@/lib/automation/personalize';
import { claimJob, finishJob, suspendJob, type FinalJobStatus } from '@/lib/automation/queue';
import {
  dispatchAction,
  loadActions,
  persistActions,
  type ActionRef,
  type ActionSnapshot,
  type DispatchResult,
  type PlannedAction,
  type SendSpec,
} from '@/lib/automation/actions';

const logger = createLogger('worker');

/** Meta's DM window: only message users who engaged within the last 24h. */
const MAX_EVENT_AGE_MS = 24 * 60 * 60 * 1000;

/** Sleeps longer than this release the job lease (status 'suspended') first. */
const SUSPEND_THRESHOLD_MS = 60_000;

/** Bounds waits (rate window, pause, retry backoff) per action. */
const MAX_DISPATCH_ROUNDS = 12;

/** The subset of Inngest step tools the workflow needs; results must be JSON. */
export interface WorkflowStep {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
  sleep(id: string, ms: number): Promise<void>;
}

export type JobOutcomeStatus = FinalJobStatus | 'not_claimed' | 'lost';

export interface JobOutcome {
  status: JobOutcomeStatus;
}

/** Randomized pre-send delay - automation that behaves like a human. */
function jitterMs(): number {
  return 2000 + Math.floor(Math.random() * 3000);
}

/** Shorter humanized pause BETWEEN consecutive messages in one flow. */
function interMessageMs(): number {
  return 1200 + Math.floor(Math.random() * 1300);
}

// ═══════════════════════════════════════════════════════════════════════════
// Workflow
// ═══════════════════════════════════════════════════════════════════════════

export async function executeJob(step: WorkflowStep, jobId: string, owner: string): Promise<JobOutcome> {
  const job = await step.run('claim', () => claimJob(jobId, owner));
  if (!job) return { status: 'not_claimed' };

  const plan = await step.run('prepare', () => prepareJob(job));
  if (plan.kind === 'finish') {
    await step.run('finish', () => finishJob(jobId, owner, plan.status, plan.reason));
    return { status: plan.status };
  }

  await step.sleep('jitter', jitterMs());

  let halted: DispatchResult | null = null;
  for (const [index, action] of plan.actions.entries()) {
    if (index > 0) await step.sleep(`gap:${action.key}`, interMessageMs());
    const result = await dispatchWithWaits(step, jobId, owner, action);
    if (result.state === 'lost') return { status: 'lost' };
    if (result.halt) {
      halted = result;
      break;
    }
  }

  const status = await step.run('finalize', () => finalizeJob(jobId, owner, halted));
  return { status };
}

async function dispatchWithWaits(step: WorkflowStep, jobId: string, owner: string, action: ActionRef): Promise<DispatchResult> {
  for (let round = 0; round < MAX_DISPATCH_ROUNDS; round += 1) {
    const result = await step.run(`dispatch:${action.key}:${round}`, () => dispatchAction(jobId, owner, action.id));
    if (result.state !== 'wait') return result;

    const sleepId = `wait:${action.key}:${round}`;
    const ms = Math.max(0, Date.parse(result.waitUntil) - Date.now());
    if (ms <= SUSPEND_THRESHOLD_MS) {
      await step.sleep(sleepId, ms);
      continue;
    }
    // Long waits release the lease so it cannot silently expire mid-sleep.
    await step.run(`suspend:${action.key}:${round}`, () => suspendJob(jobId, owner, new Date(result.waitUntil), result.reason));
    await step.sleep(sleepId, ms);
    const reclaimed = await step.run(`resume:${action.key}:${round}`, () => claimJob(jobId, owner));
    if (!reclaimed) return { state: 'lost', halt: true, reason: 'Job was taken over while suspended' };
  }
  return { state: 'failed', halt: true, reason: 'Gave up after repeated waits' };
}

/** Persists a run failure (retries exhausted) without restarting the flow. */
export async function recordJobFailure(jobId: string, message: string): Promise<void> {
  const db = createServiceClient();
  const actions = await loadActions(jobId);
  for (const action of actions.filter((a) => a.state === 'dispatching')) {
    const { error } = await db.rpc('complete_action_dispatch', {
      p_action_id: action.id,
      p_state: 'uncertain',
      p_error_class: 'dispatch_interrupted',
      p_error: 'Workflow failed while this send was in flight',
    });
    if (error) throw new Error(`complete_action_dispatch failed for ${action.id}: ${error.message}`);
  }
  const uncertain = actions.some((a) => a.state === 'dispatching' || a.state === 'uncertain');
  await finishJob(jobId, null, uncertain ? 'uncertain' : 'failed', message);
}

// ═══════════════════════════════════════════════════════════════════════════
// Preparation
// ═══════════════════════════════════════════════════════════════════════════

export type JobPlan =
  | { kind: 'send'; actions: ActionRef[] }
  | { kind: 'finish'; status: 'done' | 'skipped'; reason: string };

function finish(status: 'done' | 'skipped', reason: string): JobPlan {
  return { kind: 'finish', status, reason };
}

/** Plans the job once; a replay or recovered run reuses the stored actions. */
export async function prepareJob(job: JobQueueRow): Promise<JobPlan> {
  const existing = await loadActions(job.id);
  if (existing.length > 0) return { kind: 'send', actions: existing.map((a) => ({ id: a.id, key: a.action_key })) };

  const planned = job.job_type === 'follow_up' ? await planFollowUp(job) : await planAutoDm(job);
  if (!Array.isArray(planned)) return planned;
  if (planned.length === 0) return finish('skipped', 'Nothing to send');
  return { kind: 'send', actions: await persistActions(job, planned) };
}

function snapshot(send: SendSpec, logText: string, opts: Partial<ActionSnapshot> = {}): ActionSnapshot {
  return {
    send,
    logText,
    bestEffort: opts.bestEffort ?? false,
    countsTowardRate: opts.countsTowardRate ?? send.type !== 'comment_reply',
    session: opts.session ?? null,
  };
}

/** A configured response (text w/ optional link button, or card) as a send. */
function responseSend(response: DMResponse, recipient: DmRecipient, audienceId: string, username: string | null | undefined): { send: SendSpec; logText: string } {
  if (response.type === 'card') {
    const cardImageUrl = response.cardImage?.startsWith('http') ? response.cardImage : undefined;
    return {
      send: {
        type: 'card',
        recipientId: audienceId,
        card: {
          title: response.cardTitle ?? response.content,
          ...(cardImageUrl !== undefined ? { imageUrl: cardImageUrl } : {}),
          ...(response.cardSubtitle !== undefined ? { subtitle: response.cardSubtitle } : {}),
          ...(response.cardButtons !== undefined
            ? { buttons: response.cardButtons.map((b) => ({ title: b.title, url: b.link })) }
            : {}),
        },
      },
      logText: response.cardTitle ?? response.content ?? 'Card message',
    };
  }
  const text = renderTemplate(response.content.trim(), username);
  const link = response.buttonLink?.trim();
  if (link) {
    return { send: { type: 'link', recipient, text, buttonTitle: response.buttonTitle?.trim() || 'Open link', url: link }, logText: text };
  }
  return { send: { type: 'text', recipient, text }, logText: text };
}

function hasContent(r: DMResponse): boolean {
  return Boolean(r.content?.trim()) || r.type === 'card';
}

/** Session IDs derive from the job so a re-planned job finds its own session. */
function sessionIdForJob(jobId: string): string {
  const h = createHash('sha256').update(`session:${jobId}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

async function loadActiveAccount(db: SupabaseClient, accountId: string): Promise<InstagramAccountRow | null> {
  const { data, error } = await db.from('instagram_accounts').select('*').eq('id', accountId).eq('is_active', true).maybeSingle();
  if (error) throw new Error(`instagram_accounts lookup failed: ${error.message}`);
  return data as InstagramAccountRow | null;
}

async function planAutoDm(job: JobQueueRow): Promise<PlannedAction[] | JobPlan> {
  const db = createServiceClient();
  const payload = job.payload;

  debugLog('worker', 'info', 'job_started', 'processing', `AutoDM job started - ${payload.triggerType} trigger`, {
    automationId: payload.automationId,
    triggerType: payload.triggerType,
    triggerUserId: payload.triggerUserId,
    triggerEventId: payload.triggerEventId,
  });

  const eventAge = Date.now() - payload.triggerTimestamp;
  if (eventAge > MAX_EVENT_AGE_MS) {
    debugLog('worker', 'warn', 'window_check', 'skipped', `Event ${Math.round(eventAge / 3600000)}h old - outside 24h DM window`, {
      ageHours: Math.round(eventAge / 3600000),
    });
    await markJobStatus(db, payload, 'skipped', 'Event outside 24-hour DM window');
    return finish('skipped', 'Event outside 24-hour DM window');
  }

  // Application-level dedup; DB unique constraints are the backstop.
  const { data: existingLog, error: logError } = await db
    .from('dm_sent_log')
    .select('id')
    .eq('automation_id', payload.automationId)
    .eq('trigger_event_id', payload.triggerEventId)
    .maybeSingle();
  if (logError) throw new Error(`dm_sent_log lookup failed: ${logError.message}`);
  if (existingLog) {
    await markJobStatus(db, payload, 'skipped', 'Duplicate event');
    return finish('skipped', 'Duplicate event');
  }

  const { data: userLog, error: userLogError } = await db
    .from('dm_sent_log')
    .select('id')
    .eq('automation_id', payload.automationId)
    .eq('trigger_user_id', payload.triggerUserId)
    .maybeSingle();
  if (userLogError) throw new Error(`dm_sent_log lookup failed: ${userLogError.message}`);
  if (userLog) {
    debugLog('worker', 'info', 'dedup_check', 'skipped', `User ${payload.triggerUserId} already received this automation`, {});
    await markJobStatus(db, payload, 'skipped', 'User already received this automation');
    return finish('skipped', 'User already received this automation');
  }

  const { data: automationRow, error: automationError } = await db
    .from('automations')
    .select('*')
    .eq('id', payload.automationId)
    .eq('is_active', true)
    .maybeSingle();
  if (automationError) throw new Error(`automation lookup failed: ${automationError.message}`);
  const automation = automationRow as AutomationRow | null;
  if (!automation) {
    await markJobStatus(db, payload, 'skipped', 'Automation not found or inactive');
    return finish('skipped', 'Automation not found or inactive');
  }

  if (!(await loadActiveAccount(db, payload.instagramAccountId))) {
    await markJobStatus(db, payload, 'skipped', 'Instagram account not found or inactive');
    return finish('skipped', 'Instagram account not found or inactive');
  }

  await markJobStatus(db, payload, 'processing', null);
  const planned: PlannedAction[] = [];

  // Public reply goes BEFORE the DM; the snapshot freezes the random pick.
  if (payload.triggerType === 'comment' && automation.comment_reply_options.length > 0 && payload.triggerEventId) {
    const reply = automation.comment_reply_options[Math.floor(Math.random() * automation.comment_reply_options.length)];
    if (reply) {
      const text = renderTemplate(reply, payload.triggerUsername);
      planned.push({
        key: '00:public_reply',
        snapshot: snapshot({ type: 'comment_reply', commentId: payload.triggerEventId, text }, text, { bestEffort: true }),
      });
    }
  }

  // Comment triggers go out as PRIVATE REPLIES (recipient: comment_id) -
  // Meta's purpose-built comment-to-DM channel: separate 750/h allowance,
  // valid 7 days after the comment, more deliverable than general messaging.
  const recipient: DmRecipient =
    payload.triggerType === 'comment' && payload.triggerEventId
      ? { commentId: payload.triggerEventId }
      : { id: payload.triggerUserId };

  if (!automation.dm_opening_message_enabled || !automation.dm_opening_message.trim()) {
    // Opening message is off - the FIRST response becomes the initial DM.
    const firstResponse = (automation.dm_responses ?? []).find(hasContent);
    if (!firstResponse) {
      debugLog('worker', 'info', 'opening_dm', 'skipped', 'Opening DM disabled and no responses configured - nothing to send', {});
      if (planned.length === 0) {
        await markJobStatus(db, payload, 'skipped', 'DM disabled');
        return finish('skipped', 'DM disabled');
      }
      return planned;
    }
    const directRecipient = firstResponse.type === 'card' ? { id: payload.triggerUserId } : recipient;
    const { send, logText } = responseSend(firstResponse, directRecipient, payload.triggerUserId, payload.triggerUsername);
    planned.push({ key: '01:opening', snapshot: snapshot(send, logText) });
    return planned;
  }

  let sessionId: string | null = null;
  if (automation.dm_opening_message_button_title?.trim()) {
    // Session row FIRST - its ID is the routing key embedded in the button payload.
    const candidate = sessionIdForJob(job.id);
    const { error: sessionError } = await db.from('automation_sessions').insert({
      id: candidate,
      automation_id: payload.automationId,
      instagram_account_id: payload.instagramAccountId,
      audience_ig_user_id: payload.triggerUserId,
      current_step: 1,
      completed: false,
      expires_at: new Date(Date.now() + MAX_EVENT_AGE_MS).toISOString(),
    });
    if (!sessionError) {
      sessionId = candidate;
    } else if (sessionError.code === '23505') {
      const { data: own, error: ownError } = await db.from('automation_sessions').select('id').eq('id', candidate).maybeSingle();
      if (ownError) throw new Error(`automation_sessions lookup failed: ${ownError.message}`);
      if (!own) {
        debugLog('worker', 'info', 'session_create', 'skipped', `Active session already exists for ${payload.triggerUserId}`, {});
        await markJobStatus(db, payload, 'skipped', 'Session already active');
        return finish('skipped', 'Session already active');
      }
      sessionId = candidate;
    } else {
      logger.warn({ err: sessionError }, 'Session insert failed - degrading to plain DM');
      debugLog('worker', 'warn', 'session_create', 'error', 'Session insert failed - sending plain DM without button', {
        error: sessionError.message,
      });
    }
  }

  const messageText = renderTemplate(automation.dm_opening_message.trim(), payload.triggerUsername);
  const openingLink = automation.dm_opening_message_button_link?.trim();
  let opening: SendSpec;
  if (sessionId) {
    // 2-step flow: opening message + postback button ("Send me the link")
    opening = {
      type: 'text',
      recipient,
      text: messageText,
      quickReply: { title: automation.dm_opening_message_button_title!.trim(), payload: `SESSION_${sessionId}_STEP_1` },
    };
  } else if (openingLink) {
    const buttonTitle = automation.dm_opening_message_button_title?.trim() || 'Open link';
    opening = { type: 'link', recipient, text: messageText, buttonTitle, url: openingLink };
  } else {
    opening = { type: 'text', recipient, text: messageText };
  }
  planned.push({
    key: '01:opening',
    snapshot: snapshot(opening, messageText, { session: sessionId ? { id: sessionId, step: 1, effect: 'none' } : null }),
  });

  // 1-step flow: no reveal button → no tap is coming, deliver responses now.
  // Each is best-effort, as before: one rejected response does not stop the rest.
  if (!sessionId) {
    for (const [idx, response] of (automation.dm_responses ?? []).entries()) {
      if (!hasContent(response)) continue;
      const { send, logText } = responseSend(response, { id: payload.triggerUserId }, payload.triggerUserId, payload.triggerUsername);
      planned.push({ key: `02:response:${String(idx).padStart(3, '0')}`, snapshot: snapshot(send, logText, { bestEffort: true }) });
    }
  }
  return planned;
}

async function planFollowUp(job: JobQueueRow): Promise<PlannedAction[] | JobPlan> {
  const db = createServiceClient();
  const payload = job.payload;

  debugLog('worker', 'info', 'followup_started', 'processing', `Follow-up job started - step ${payload.sessionStep}`, {
    sessionId: payload.sessionId ?? null,
    sessionStep: payload.sessionStep ?? null,
    triggerUserId: payload.triggerUserId,
  });

  if (!payload.sessionId) return finish('skipped', 'Follow-up job has no sessionId');
  const sessionId = payload.sessionId;

  const { data: sessionRow, error: sessionError } = await db
    .from('automation_sessions')
    .select('id, automation_id, instagram_account_id, audience_ig_user_id, current_step, expires_at, completed')
    .eq('id', sessionId)
    .maybeSingle();
  if (sessionError) throw new Error(`automation_sessions lookup failed: ${sessionError.message}`);
  const session = sessionRow as { current_step: number; expires_at: string; completed: boolean } | null;
  if (!session) return finish('skipped', `Session ${sessionId} not found`);
  if (session.completed) return finish('skipped', `Session ${sessionId} already completed`);
  if (new Date(session.expires_at) < new Date()) {
    await db.from('automation_sessions').update({ completed: true }).eq('id', sessionId);
    return finish('skipped', `Session ${sessionId} expired`);
  }
  const expectedStep = session.current_step;
  if (payload.sessionStep !== undefined && payload.sessionStep !== expectedStep) {
    debugLog('worker', 'warn', 'session_verify', 'skipped',
      `Step mismatch: tap says ${payload.sessionStep}, session expects ${expectedStep} - stale button tap`, {});
    return finish('skipped', 'Stale button tap');
  }

  const { data: automationRow, error: automationError } = await db
    .from('automations')
    .select('dm_responses, dm_opening_message_button_link, ask_to_follow_enabled, ask_to_follow_message, ask_to_follow_visit_profile_button, ask_to_follow_confirm_button')
    .eq('id', payload.automationId)
    .eq('is_active', true)
    .maybeSingle();
  if (automationError) throw new Error(`automation lookup failed: ${automationError.message}`);
  const automation = automationRow as AutomationRow | null;
  if (!automation) {
    await db.from('automation_sessions').update({ completed: true }).eq('id', sessionId);
    return finish('skipped', 'Automation inactive');
  }

  const igAccount = await loadActiveAccount(db, payload.instagramAccountId);
  if (!igAccount) return finish('skipped', 'Instagram account not found or inactive');

  const sessionRef = (effect: 'advance' | 'touch' | 'complete') => ({ session: { id: sessionId, step: expectedStep, effect } });

  // Ask-to-follow gate (REAL follow check via the User Profile API):
  //   step 1 tap → follower? deliver : send ask card, session → step 2
  //   step 2 tap ("I'm following") → re-check: follower? deliver : gentle nudge
  // Unknown results FAIL OPEN - never block a real person on an API hiccup.
  if (automation.ask_to_follow_enabled && (expectedStep === 1 || expectedStep === 2)) {
    const accessToken = decrypt(igAccount.access_token_encrypted, getEnv().TOKEN_ENCRYPTION_KEY);
    const audienceProfile = await getAudienceProfile(payload.triggerUserId, accessToken);
    const follows = audienceProfile?.followsBusiness ?? null;
    updateContactProfile({
      instagramAccountId: payload.instagramAccountId,
      audienceIgUserId: payload.triggerUserId,
      username: audienceProfile?.username ?? null,
      followsBusiness: follows,
    });

    if (follows === false && expectedStep === 1) {
      const options = {
        message: automation.ask_to_follow_message,
        creatorUsername: igAccount.username ?? '',
        visitProfileButtonTitle: automation.ask_to_follow_visit_profile_button,
        confirmButtonTitle: automation.ask_to_follow_confirm_button,
        confirmPayload: `SESSION_${sessionId}_STEP_2`,
      };
      return [{
        key: '01:ask_follow',
        snapshot: snapshot({ type: 'ask_follow', recipientId: payload.triggerUserId, options }, options.message, sessionRef('advance')),
      }];
    }
    if (follows === false && expectedStep === 2) {
      // Still not following - nudge and keep the session at step 2 so the card's buttons stay live.
      const text = `Hmm, I still can't see your follow 👀 Tap "${automation.ask_to_follow_visit_profile_button}" above, hit Follow, then tap "${automation.ask_to_follow_confirm_button}" again 🙏`;
      return [{
        key: '01:follow_nudge',
        snapshot: snapshot({ type: 'text', recipient: { id: payload.triggerUserId }, text }, text, sessionRef('touch')),
      }];
    }
    debugLog('worker', 'info', 'follow_check', 'ok',
      follows === true ? 'Audience member follows - delivering content' : 'Follow status unknown - failing open, delivering content',
      { sessionId, triggerUserId: payload.triggerUserId });
  }

  const responses = (automation.dm_responses ?? []).filter(hasContent);
  if (responses.length === 0) {
    debugLog('worker', 'warn', 'responses_send', 'skipped', 'Automation has 0 dm_responses - session completed with no content', {
      hint: 'Add at least one response (text or card) in the automation configuration',
    });
    await db.from('automation_sessions').update({ completed: true, last_activity_at: new Date().toISOString() }).eq('id', sessionId);
    return finish('done', 'No responses configured');
  }

  return responses.map((response, idx) => {
    const { send, logText } = responseSend(response, { id: payload.triggerUserId }, payload.triggerUserId, payload.triggerUsername);
    return { key: `01:response:${String(idx).padStart(3, '0')}`, snapshot: snapshot(send, logText, sessionRef('complete')) };
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Finalization
// ═══════════════════════════════════════════════════════════════════════════

/** Records side effects of what was actually accepted and settles the job. */
export async function finalizeJob(jobId: string, owner: string, halted: DispatchResult | null): Promise<FinalJobStatus> {
  const db = createServiceClient();
  const { data: jobRow, error: jobError } = await db.from('job_queue').select('*').eq('id', jobId).maybeSingle();
  if (jobError || !jobRow) throw new Error(`job_queue load failed for ${jobId}: ${jobError?.message ?? 'not found'}`);
  const job = jobRow as JobQueueRow;
  const payload = job.payload;
  const actions = await loadActions(jobId);
  const accepted = actions.filter((a) => a.state === 'accepted');
  const dmsAccepted = accepted.filter((a) => a.message_snapshot.countsTowardRate);

  let status: FinalJobStatus = 'done';
  if (actions.some((a) => a.state === 'uncertain')) status = 'uncertain';
  else if (halted?.state === 'skipped') status = 'skipped';
  else if (halted) status = 'failed';
  const reason = halted?.reason ?? null;

  if (job.job_type === 'follow_up') {
    await finalizeFollowUp(db, payload, accepted.map((a) => a.message_snapshot), status);
  } else {
    if (accepted.some((a) => a.action_kind === 'public_reply') && payload.triggerEventId) {
      await db
        .from('dm_jobs')
        .update({ public_reply_sent_at: new Date().toISOString() })
        .eq('automation_id', payload.automationId)
        .eq('trigger_event_id', payload.triggerEventId);
    }
    if (dmsAccepted.length > 0) {
      await recordDelivery(db, payload, dmsAccepted.map((a) => a.message_snapshot));
    } else {
      await markJobStatus(db, payload, status === 'skipped' ? 'skipped' : 'failed', reason ?? 'No DM delivered');
      const opening = actions.find((a) => a.action_key === '01:opening');
      // Orphaned session cleanup, only when the opening DM was definitely not sent.
      if (opening?.state === 'failed' && opening.message_snapshot.session) {
        await db.from('automation_sessions').delete().eq('id', opening.message_snapshot.session.id);
      }
    }
  }

  await finishJob(jobId, owner, status, reason);
  debugLog('worker', status === 'done' ? 'info' : 'warn', 'job_completed', status === 'done' ? 'ok' : 'error',
    `Job ${status}: ${accepted.length}/${actions.length} send(s) accepted${reason ? ` - ${reason}` : ''}`,
    { jobId, automationId: payload.automationId });
  return status;
}

async function recordDelivery(db: SupabaseClient, payload: AutoDmJobPayload, delivered: ActionSnapshot[]): Promise<void> {
  const { error: logError } = await db.from('dm_sent_log').insert({
    instagram_account_id: payload.instagramAccountId,
    automation_id: payload.automationId,
    trigger_user_id: payload.triggerUserId,
    trigger_event_id: payload.triggerEventId,
  });
  if (logError && logError.code !== '23505') throw new Error(`dm_sent_log insert failed: ${logError.message}`);

  await markJobStatus(db, payload, 'sent', null, new Date());

  const opening = delivered.find((s) => s.session);
  if (opening?.session) {
    await db.from('dm_logs').insert({
      session_id: opening.session.id,
      direction: 'outbound',
      step: 1,
      message_text: opening.logText,
    });
  }

  const { error: counterError } = await db.rpc('increment_automation_dms_sent', { automation_id: payload.automationId });
  if (counterError) logger.warn({ err: counterError }, 'Failed to increment DM counter');

  // Contacts: DM/story webhooks don't carry a username - enrich it (and the
  // follow flag) from the profile API now that they've messaged us.
  if (payload.triggerType !== 'comment') void enrichContact(db, payload);
}

async function enrichContact(db: SupabaseClient, payload: AutoDmJobPayload): Promise<void> {
  try {
    const account = await loadActiveAccount(db, payload.instagramAccountId);
    if (!account) return;
    const profile = await getAudienceProfile(payload.triggerUserId, decrypt(account.access_token_encrypted, getEnv().TOKEN_ENCRYPTION_KEY));
    if (profile) {
      updateContactProfile({
        instagramAccountId: payload.instagramAccountId,
        audienceIgUserId: payload.triggerUserId,
        username: profile.username,
        followsBusiness: profile.followsBusiness,
      });
    }
  } catch (err) {
    logger.warn({ err }, 'Contact enrichment failed');
  }
}

async function finalizeFollowUp(
  db: SupabaseClient,
  payload: AutoDmJobPayload,
  delivered: ActionSnapshot[],
  status: FinalJobStatus
): Promise<void> {
  const last = delivered[delivered.length - 1];
  if (!last?.session || !payload.sessionId) return;
  const now = new Date().toISOString();

  if (last.session.effect === 'advance') {
    await db.from('automation_sessions').update({ current_step: 2, last_activity_at: now }).eq('id', payload.sessionId);
    return;
  }
  if (last.session.effect === 'touch' || status !== 'done') {
    await db.from('automation_sessions').update({ last_activity_at: now }).eq('id', payload.sessionId);
    return;
  }

  if (payload.messageText) {
    await db.from('dm_logs').insert({ session_id: payload.sessionId, direction: 'inbound', step: last.session.step, message_text: payload.messageText });
  }
  await db.from('dm_logs').insert({ session_id: payload.sessionId, direction: 'outbound', step: last.session.step, message_text: last.logText });
  await db.from('automation_sessions').update({ completed: true, last_activity_at: now }).eq('id', payload.sessionId);
  await db.rpc('increment_automation_dms_sent', { automation_id: payload.automationId });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

type DmJobStatus = 'queued' | 'processing' | 'sent' | 'failed' | 'skipped';

export async function markJobStatus(
  db: SupabaseClient,
  payload: AutoDmJobPayload,
  status: DmJobStatus,
  errorMessage: string | null,
  sentAt?: Date
): Promise<void> {
  const { error } = await db.from('dm_jobs').upsert(
    {
      automation_id: payload.automationId,
      instagram_account_id: payload.instagramAccountId,
      trigger_type: payload.triggerType,
      trigger_user_id: payload.triggerUserId,
      trigger_event_id: payload.triggerEventId,
      trigger_timestamp: new Date(payload.triggerTimestamp).toISOString(),
      status,
      error_message: errorMessage,
      sent_at: sentAt?.toISOString() ?? null,
    },
    { onConflict: 'automation_id,trigger_event_id', ignoreDuplicates: false }
  );
  if (error) logger.warn({ err: error, status }, 'Failed to upsert dm_job status');
}
