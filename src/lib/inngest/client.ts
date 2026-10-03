/**
 * Server-side Inngest client and typed internal events.
 *
 * Event payloads carry only IDs, account IDs and publication generations -
 * never message text or tokens. The SDK reads INNGEST_EVENT_KEY,
 * INNGEST_SIGNING_KEY and INNGEST_DEV from the environment.
 */

import { Inngest, eventType, staticSchema } from 'inngest';
import { setInboxPublisher } from '@/lib/automation/inbox';
import { markPublished } from '@/lib/automation/queue';

export const inngest = new Inngest({ id: 'open-autodm' });

export const webhookReceived = eventType('instagram/webhook.received', {
  schema: staticSchema<{ inboxId: string; instagramAccountId: string; generation: number }>(),
});

export const jobReady = eventType('instagram/job.ready', {
  schema: staticSchema<{ jobId: string; instagramAccountId: string; generation: number }>(),
});

/** Event IDs make a republished generation a new event and a repeated send of the same generation a no-op. */
export function webhookReceivedEvent(inboxId: string, instagramAccountId: string, generation: number) {
  return { name: webhookReceived.name, id: `inbox-${inboxId}-${generation}`, data: { inboxId, instagramAccountId, generation } };
}

export function jobReadyEvent(jobId: string, instagramAccountId: string, generation: number) {
  return { name: jobReady.name, id: `job-${jobId}-${generation}`, data: { jobId, instagramAccountId, generation } };
}

// Freshly stored rows are generation 0; recovery claims bump the generation.
setInboxPublisher(async (refs) => {
  await inngest.send(refs.map((r) => webhookReceivedEvent(r.inboxId, r.instagramAccountId, 0)));
  await Promise.all(refs.map((r) => markPublished('webhook_inbox', r.inboxId, 0)));
});
