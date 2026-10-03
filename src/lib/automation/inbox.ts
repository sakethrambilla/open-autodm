/**
 * Durable webhook ingress.
 *
 * The receiver splits a verified Meta envelope into supported events and
 * stores each one in webhook_inbox under a stable per-account key before
 * acknowledging. Duplicate deliveries hit the unique key and are no-ops.
 * Processing happens later from the stored row, never in the receiver.
 */

import { z } from 'zod';
import { createServiceClient } from '@/lib/supabase/service';
import { processInboxEvent, type ProcessEventResult } from '@/lib/automation/processWebhook';
import type { MetaWebhookMessaging, NormalizedWebhookEvent, WebhookInboxRow } from '@/lib/types';

export const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

const envelopeSchema = z.object({
  object: z.string(),
  entry: z
    .array(
      z
        .object({
          id: z.string().min(1),
          time: z.number(),
          changes: z.array(z.object({ field: z.string(), value: z.unknown() }).passthrough()).optional(),
          messaging: z.array(z.unknown()).optional(),
        })
        .passthrough()
    )
    .max(100),
});

const commentSchema = z
  .object({
    id: z.string().min(1),
    text: z.string(),
    from: z.object({ id: z.string().min(1), username: z.string().optional() }).passthrough(),
    media: z.object({ id: z.string().min(1) }).passthrough(),
    timestamp: z.number().optional(),
    parent_id: z.string().optional(),
  })
  .passthrough();

const messagingSchema = z
  .object({
    sender: z.object({ id: z.string().min(1) }),
    recipient: z.object({ id: z.string().min(1) }),
    timestamp: z.number(),
  })
  .passthrough();

export interface ExtractedEvent {
  igAccountIgsid: string;
  eventKey: string;
  occurredAtMs: number | null;
  event: NormalizedWebhookEvent;
}

/**
 * Splits a signed envelope into supported events. Returns null when the
 * envelope itself is malformed; unsupported events (echoes, receipts, other
 * change fields) are dropped.
 */
export function extractEvents(body: unknown): ExtractedEvent[] | null {
  const parsed = envelopeSchema.safeParse(body);
  if (!parsed.success) return null;
  if (parsed.data.object !== 'instagram') return [];

  const events: ExtractedEvent[] = [];
  for (const entry of parsed.data.entry) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'comments') continue;
      const comment = commentSchema.safeParse(change.value);
      if (!comment.success) continue;
      events.push({
        igAccountIgsid: entry.id,
        eventKey: `comment:${comment.data.id}`,
        occurredAtMs: (comment.data.timestamp ?? entry.time) * 1000,
        event: { kind: 'comment', igAccountIgsid: entry.id, entryTime: entry.time, comment: comment.data },
      });
    }

    for (const raw of entry.messaging ?? []) {
      if (!messagingSchema.safeParse(raw).success) continue;
      const messaging = raw as MetaWebhookMessaging;
      const extracted = extractMessaging(entry.id, messaging);
      if (extracted) events.push(extracted);
    }
  }
  return events;
}

function extractMessaging(igAccountIgsid: string, messaging: MetaWebhookMessaging): ExtractedEvent | null {
  if (messaging.message?.is_echo || messaging.read || messaging.delivery) return null;
  const occurredAtMs = messaging.timestamp;

  if (messaging.postback && !messaging.message) {
    // Payload-scoped fallback: a user tapping the same button twice in one ms is the only collision.
    const key = messaging.postback.mid
      ? `postback:${messaging.postback.mid}`
      : `postback:${messaging.sender.id}:${messaging.timestamp}:${messaging.postback.payload}`;
    return { igAccountIgsid, eventKey: key, occurredAtMs, event: { kind: 'postback', igAccountIgsid, messaging } };
  }

  if (messaging.message?.mid) {
    return {
      igAccountIgsid,
      eventKey: `message:${messaging.message.mid}`,
      occurredAtMs,
      event: { kind: 'message', igAccountIgsid, messaging },
    };
  }
  return null;
}

export interface InboxReceipt {
  stored: Array<{ id: string; instagramAccountId: string }>;
  duplicates: number;
  unknownAccount: number;
}

/**
 * Persists events for connected, active accounts. Throws on any database
 * error so the caller can return 5xx and let Meta redeliver.
 */
export async function storeInboxEvents(events: ExtractedEvent[]): Promise<InboxReceipt> {
  const receipt: InboxReceipt = { stored: [], duplicates: 0, unknownAccount: 0 };
  if (events.length === 0) return receipt;

  const db = createServiceClient();
  const igsids = [...new Set(events.map((e) => e.igAccountIgsid))];
  const { data: accounts, error: accountError } = await db
    .from('instagram_accounts')
    .select('id, instagram_user_id')
    .in('instagram_user_id', igsids)
    .eq('is_active', true);
  if (accountError) throw new Error(`instagram_accounts lookup failed: ${accountError.message}`);

  const accountIdsByIgsid = new Map<string, string[]>();
  for (const a of (accounts ?? []) as Array<{ id: string; instagram_user_id: string }>) {
    accountIdsByIgsid.set(a.instagram_user_id, [...(accountIdsByIgsid.get(a.instagram_user_id) ?? []), a.id]);
  }

  const rows: Array<Record<string, unknown>> = [];
  for (const e of events) {
    const accountIds = accountIdsByIgsid.get(e.igAccountIgsid);
    if (!accountIds) {
      receipt.unknownAccount += 1;
      continue;
    }
    for (const accountId of accountIds) {
      rows.push({
        instagram_account_id: accountId,
        event_key: e.eventKey,
        event_kind: e.event.kind,
        payload: e.event,
        occurred_at: e.occurredAtMs === null ? null : new Date(e.occurredAtMs).toISOString(),
      });
    }
  }
  if (rows.length === 0) return receipt;

  const { data: inserted, error: insertError } = await db
    .from('webhook_inbox')
    .upsert(rows, { onConflict: 'instagram_account_id,event_key', ignoreDuplicates: true })
    .select('id, instagram_account_id');
  if (insertError) throw new Error(`webhook_inbox insert failed: ${insertError.message}`);

  for (const r of (inserted ?? []) as Array<{ id: string; instagram_account_id: string }>) {
    receipt.stored.push({ id: r.id, instagramAccountId: r.instagram_account_id });
  }
  receipt.duplicates = rows.length - receipt.stored.length;
  return receipt;
}

export interface InboxPublicationRef {
  inboxId: string;
  instagramAccountId: string;
}

export type InboxPublisher = (refs: InboxPublicationRef[]) => Promise<void>;

let inboxPublisher: InboxPublisher | null = null;

/** Registers the event publisher (Inngest). Without one, rows stay publish_state='pending' for recovery. */
export function setInboxPublisher(publisher: InboxPublisher | null): void {
  inboxPublisher = publisher;
}

/**
 * Bounded best-effort publication of freshly stored events. Never throws:
 * the rows are already durable and recovery republishes anything still pending.
 */
export async function publishInboxEvents(refs: InboxPublicationRef[], timeoutMs = 2000): Promise<'published' | 'pending'> {
  if (refs.length === 0 || !inboxPublisher) return 'pending';
  const publisher = inboxPublisher;
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      publisher(refs),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('publication timed out')), timeoutMs);
      }),
    ]).finally(() => clearTimeout(timer));
    return 'published';
  } catch {
    return 'pending';
  }
}

export async function loadInboxEvent(inboxId: string): Promise<WebhookInboxRow | null> {
  const db = createServiceClient();
  const { data, error } = await db.from('webhook_inbox').select('*').eq('id', inboxId).maybeSingle();
  if (error) throw new Error(`webhook_inbox load failed: ${error.message}`);
  return (data as WebhookInboxRow | null) ?? null;
}

/**
 * Runs matching/session logic for one stored event and marks it processed.
 * Safe to replay: job creation is idempotent and reports existing job IDs.
 */
export async function processStoredInboxEvent(inboxId: string): Promise<ProcessEventResult> {
  const row = await loadInboxEvent(inboxId);
  if (!row) return { created: [], existing: [] };
  const result = await processInboxEvent(row.instagram_account_id, row.payload, row.id);
  const db = createServiceClient();
  const { error } = await db.from('webhook_inbox').update({ state: 'processed', last_error: null }).eq('id', inboxId);
  if (error) throw new Error(`webhook_inbox update failed: ${error.message}`);
  return result;
}

/** Failure hook: the event exhausted its retries. Terminal - recovery never republishes failed rows. */
export async function markInboxFailed(inboxId: string, message: string): Promise<void> {
  const db = createServiceClient();
  const { error } = await db
    .from('webhook_inbox')
    .update({ state: 'failed', last_error: message.slice(0, 2000) })
    .eq('id', inboxId);
  if (error) throw new Error(`webhook_inbox update failed: ${error.message}`);
}
