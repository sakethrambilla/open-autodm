/**
 * Stored webhook event processing - routes one normalized Meta event to queue jobs.
 *
 * Called with a webhook_inbox row's event, never from the HTTP receiver. A
 * stored event may be replayed, so every write is idempotent: job creation
 * reports created vs. existing IDs and database errors are thrown so the
 * caller can retry instead of silently dropping work.
 *
 *  comment events → keyword/post match → one auto_dm job per account/comment
 *  DM events      → quick-reply/postback session routing → follow_up job
 *                 → story replies (message.reply_to.story) → story_reply keyword match
 *                 → plain DMs → dm_reply keyword match
 */

import { createServiceClient } from '@/lib/supabase/service';
import { createLogger } from '@/lib/logger';
import { debugLog } from '@/lib/debugLog';
import { keywordMatches } from '@/lib/automation/keywordMatch';
import { enqueueJob, type EnqueueResult } from '@/lib/automation/queue';
import { recordContactInteraction } from '@/lib/automation/contacts';
import type {
  MetaCommentChangeValue,
  MetaWebhookMessaging,
  AutoDmJobPayload,
  NormalizedWebhookEvent,
} from '@/lib/types';

const logger = createLogger('webhook');

/** Max event age accepted for processing: 24h window + 1h queue buffer. */
const MAX_EVENT_AGE_MS = 25 * 60 * 60 * 1000;

/** Button tap payload: SESSION_{uuid}_STEP_{n}. */
export const SESSION_TAP_PAYLOAD = /^SESSION_([0-9a-f-]+)_STEP_(\d+)$/i;

export interface ProcessEventResult {
  created: string[];
  existing: string[];
}

function emptyResult(): ProcessEventResult {
  return { created: [], existing: [] };
}

function addJob(result: ProcessEventResult, job: EnqueueResult): void {
  (job.status === 'created' ? result.created : result.existing).push(job.id);
}

export async function processInboxEvent(
  instagramAccountId: string,
  event: NormalizedWebhookEvent,
  inboxId: string | null = null
): Promise<ProcessEventResult> {
  if (event.kind === 'comment') {
    return processCommentEvent(instagramAccountId, event.igAccountIgsid, event.comment, event.entryTime, inboxId);
  }
  return processDmEvent(instagramAccountId, event.igAccountIgsid, event.messaging, inboxId);
}

async function processCommentEvent(
  instagramAccountId: string,
  igAccountIgsid: string,
  comment: MetaCommentChangeValue,
  entryTime: number,
  inboxId: string | null
): Promise<ProcessEventResult> {
  // Only top-level comments trigger - replies are ignored (incl. our own replies)
  if (comment.parent_id) {
    debugLog('webhook', 'info', 'comment_event', 'skipped', `Comment ${comment.id} is a reply - ignored`, {
      commentId: comment.id,
    });
    return emptyResult();
  }

  // Never react to the account's own comments (self-trigger loop guard)
  if (comment.from.id === igAccountIgsid) {
    debugLog('webhook', 'info', 'comment_event', 'skipped', 'Comment authored by the connected account itself - ignored', {});
    return emptyResult();
  }

  // Meta may omit comment.timestamp on IG comment webhooks - fall back to entry.time
  const triggerTimestamp = (comment.timestamp ?? entryTime) * 1000;
  const eventAgeMs = Date.now() - triggerTimestamp;

  debugLog('webhook', 'info', 'comment_event', 'processing', `Comment received: "${comment.text.slice(0, 80)}"`, {
    commentId: comment.id,
    commenterId: comment.from.id,
    commenterUsername: comment.from.username ?? null,
    postId: comment.media.id,
    ageSeconds: Math.round(eventAgeMs / 1000),
  });

  if (eventAgeMs > MAX_EVENT_AGE_MS) {
    debugLog('webhook', 'warn', 'window_check', 'skipped', `Comment ${Math.round(eventAgeMs / 3600000)}h old - beyond processing window`, {});
    return emptyResult();
  }

  const db = createServiceClient();
  const { data: automations, error } = await db
    .from('automations')
    .select('id, post_id, keywords')
    .eq('instagram_account_id', instagramAccountId)
    .eq('type', 'comment_dm')
    .eq('is_active', true)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true });

  if (error) {
    debugLog('webhook', 'error', 'automations_fetch', 'error', `DB error fetching automations: ${error.message}`, {});
    throw new Error(`automations fetch failed: ${error.message}`);
  }
  if (!automations?.length) {
    debugLog('webhook', 'info', 'automations_fetch', 'skipped', 'No active comment_dm automations for this account', {});
    return emptyResult();
  }

  debugLog('webhook', 'info', 'automations_fetch', 'ok', `Checking ${automations.length} active automation(s)`, {
    automationIds: automations.map((a) => a.id),
  });

  const result = emptyResult();
  for (const automation of automations) {
    if (automation.post_id && automation.post_id !== comment.media.id) {
      debugLog('webhook', 'info', 'post_filter', 'skipped', `Automation ${automation.id}: different post`, {
        automationId: automation.id,
      });
      continue;
    }

    if (!keywordMatches(comment.text, automation.keywords as string[] | null)) {
      debugLog('webhook', 'info', 'keyword_match', 'skipped', `Automation ${automation.id}: no keyword match`, {
        automationId: automation.id,
        keywords: automation.keywords ?? null,
      });
      continue;
    }

    debugLog('webhook', 'info', 'keyword_match', 'ok', `Automation ${automation.id}: keyword matched - enqueuing`, {
      automationId: automation.id,
    });

    const payload: AutoDmJobPayload = {
      automationId: automation.id as string,
      instagramAccountId,
      igAccountIgsid,
      triggerType: 'comment',
      triggerUserId: comment.from.id,
      triggerUsername: comment.from.username ?? null,
      triggerEventId: comment.id,
      triggerTimestamp,
      postId: comment.media.id,
      commentText: comment.text,
      messageText: null,
    };

    // Keyed by account/comment, not automation: overlapping campaigns get one initial private reply (oldest wins).
    const job = await enqueueJob('auto_dm', payload, `comment_${instagramAccountId}_${comment.id}`, inboxId);
    addJob(result, job);
    debugLog('webhook', 'info', 'job_enqueued', job.status === 'created' ? 'ok' : 'skipped',
      `AutoDM job ${job.status === 'created' ? 'enqueued' : 'already exists'} - ${job.id}`, { jobId: job.id });
    if (job.status === 'created') {
      recordContactInteraction({
        instagramAccountId,
        audienceIgUserId: comment.from.id,
        username: comment.from.username ?? null,
        triggerType: 'comment',
        automationId: automation.id as string,
      });
    }
    break;
  }
  return result;
}

async function processDmEvent(
  instagramAccountId: string,
  igAccountIgsid: string,
  messaging: MetaWebhookMessaging,
  inboxId: string | null
): Promise<ProcessEventResult> {
  // Filter echoes (our own sends), read receipts, delivery receipts
  if (messaging.message?.is_echo || messaging.read || messaging.delivery) {
    const kind = messaging.message?.is_echo ? 'echo' : messaging.read ? 'read_receipt' : 'delivery_receipt';
    debugLog('webhook', 'info', 'dm_event_filtered', 'skipped', `DM event filtered - ${kind}`, { kind });
    return emptyResult();
  }
  // Self-messaging loop guard
  if (messaging.sender.id === messaging.recipient.id) return emptyResult();

  const message = messaging.message;
  const triggerTimestamp = messaging.timestamp;
  const eventAgeMs = Date.now() - triggerTimestamp;

  debugLog('webhook', 'info', 'dm_event', 'processing', `DM received from ${messaging.sender.id}`, {
    senderId: messaging.sender.id,
    hasQuickReply: !!message?.quick_reply,
    hasPostback: !!messaging.postback,
  });

  if (eventAgeMs > MAX_EVENT_AGE_MS) {
    debugLog('webhook', 'warn', 'window_check', 'skipped', `DM event ${Math.round(eventAgeMs / 3600000)}h old - beyond window`, {});
    return emptyResult();
  }

  const db = createServiceClient();

  // ── Priority: session button tap (quick_reply OR postback) ───────────────
  // Both carry "SESSION_{uuid}_STEP_{n}". NEVER route on message.text - the
  // visible label could collide across automations.
  const tapPayload = messaging.message?.quick_reply?.payload ?? messaging.postback?.payload;
  if (tapPayload) {
    const sessionMatch = SESSION_TAP_PAYLOAD.exec(tapPayload);
    if (sessionMatch) {
      const sessionId = sessionMatch[1] as string;
      const sessionStep = parseInt(sessionMatch[2] as string, 10);
      const eventMid = message?.mid ?? messaging.postback?.mid ?? `postback_${messaging.sender.id}_${triggerTimestamp}`;
      const eventText = message?.text ?? messaging.postback?.title ?? null;

      debugLog('webhook', 'info', 'quick_reply_tap', 'processing', `Button tap - session ${sessionId} step ${sessionStep}`, {
        sessionId,
        sessionStep,
        senderId: messaging.sender.id,
      });

      const { data: session, error: sessionError } = await db
        .from('automation_sessions')
        .select('id, automation_id, completed, expires_at')
        .eq('id', sessionId)
        .maybeSingle();

      if (sessionError) {
        debugLog('webhook', 'error', 'session_lookup', 'error', `DB error fetching session: ${sessionError.message}`, {
          sessionId,
        });
        throw new Error(`automation_sessions lookup failed: ${sessionError.message}`);
      } else if (!session) {
        debugLog('webhook', 'warn', 'session_lookup', 'skipped', `Session ${sessionId} not found - tap ignored`, { sessionId });
        return emptyResult();
      } else if (session.completed || new Date(session.expires_at as string) < new Date()) {
        debugLog('webhook', 'info', 'session_lookup', 'skipped',
          `Session ${sessionId} is ${session.completed ? 'completed' : 'expired'} - tap ignored`, { sessionId });
        return emptyResult();
      } else {
        const followUpPayload: AutoDmJobPayload = {
          automationId: session.automation_id as string,
          instagramAccountId,
          igAccountIgsid,
          triggerType: 'dm_reply_followup',
          triggerUserId: messaging.sender.id,
          triggerEventId: eventMid,
          triggerTimestamp,
          postId: null,
          commentText: null,
          messageText: eventText,
          isFollowUp: true,
          sessionId,
          sessionStep,
        };
        const job = await enqueueJob('follow_up', followUpPayload, `followup_${sessionId}_${sessionStep}_${eventMid}`, inboxId);
        debugLog('webhook', 'info', 'job_enqueued', job.status === 'created' ? 'ok' : 'skipped',
          `Follow-up job ${job.status === 'created' ? `enqueued (${job.id})` : 'duplicate - ignored'}`, {
            sessionId,
            sessionStep,
          });
        if (job.status === 'created') {
          recordContactInteraction({
            instagramAccountId,
            audienceIgUserId: messaging.sender.id,
            triggerType: 'button',
            automationId: session.automation_id as string,
          });
        }
        const result = emptyResult();
        addJob(result, job);
        return result;
      }
    }
  }

  // ── Keyword matching - story replies vs plain DMs ────────────────────────
  // A story reply arrives as a normal messaging event with message.reply_to.story
  // set. It routes ONLY to story_reply automations; plain DMs route ONLY to
  // dm_reply automations - one event never fires both types.
  if (!message?.text) {
    debugLog('webhook', 'info', 'dm_event', 'skipped', 'DM has no text - skipping keyword match', {});
    return emptyResult();
  }

  const isStoryReply = !!message.reply_to?.story;
  const automationType = isStoryReply ? 'story_reply' : 'dm_reply';
  const triggerType = isStoryReply ? 'story_reply' : 'dm';

  if (isStoryReply) {
    debugLog('webhook', 'info', 'story_reply_event', 'processing', `Story reply received: "${message.text.slice(0, 60)}"`, {
      senderId: messaging.sender.id,
      storyId: message.reply_to?.story?.id ?? null,
    });
  }

  const { data: automations, error } = await db
    .from('automations')
    .select('id, keywords')
    .eq('instagram_account_id', instagramAccountId)
    .eq('type', automationType)
    .eq('is_active', true);

  if (error) {
    debugLog('webhook', 'error', 'automations_fetch', 'error', `DB error fetching ${automationType} automations: ${error.message}`, {});
    throw new Error(`${automationType} automations fetch failed: ${error.message}`);
  }
  if (!automations?.length) {
    debugLog('webhook', 'info', 'automations_fetch', 'skipped', `No active ${automationType} automations`, {});
    return emptyResult();
  }

  const result = emptyResult();
  let capturedAutomationId: string | null = null;
  for (const automation of automations) {
    if (!keywordMatches(message.text, automation.keywords as string[] | null)) {
      debugLog('webhook', 'info', 'keyword_match', 'skipped', `${automationType} ${automation.id}: no keyword match`, {
        automationId: automation.id,
      });
      continue;
    }

    debugLog('webhook', 'info', 'keyword_match', 'ok', `${automationType} ${automation.id}: matched - enqueuing`, {
      automationId: automation.id,
    });

    const payload: AutoDmJobPayload = {
      automationId: automation.id as string,
      instagramAccountId,
      igAccountIgsid,
      triggerType,
      triggerUserId: messaging.sender.id,
      triggerUsername: null,
      triggerEventId: message.mid,
      triggerTimestamp,
      postId: null,
      commentText: null,
      messageText: message.text,
    };
    const job = await enqueueJob('auto_dm', payload, `event_${automation.id}_${message.mid}`, inboxId);
    addJob(result, job);
    if (job.status === 'created') {
      capturedAutomationId = capturedAutomationId ?? (automation.id as string);
    }
  }

  if (result.created.length > 0) {
    recordContactInteraction({
      instagramAccountId,
      audienceIgUserId: messaging.sender.id,
      triggerType: isStoryReply ? 'story_reply' : 'dm',
      automationId: capturedAutomationId,
    });
  }

  if (result.created.length + result.existing.length === 0) {
    logger.debug({ senderId: messaging.sender.id, automationType }, 'Message matched no automations');
  }
  return result;
}
