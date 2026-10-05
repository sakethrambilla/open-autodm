/**
 * Recovery endpoint, called by Supabase pg_cron every five minutes with
 * Authorization: Bearer CRON_SECRET (see the Setup Wizard snippet).
 *
 * Reclassifies expired job leases and publishes up to 100 due inbox/job IDs
 * to Inngest in one batch. An empty pass makes no Inngest calls. It never
 * sends Instagram messages; token refresh and cleanup live in
 * /api/cron/maintenance.
 */

import { isCronAuthorized } from '@/lib/auth';
import { recoverAndPublish } from '@/lib/automation/queue';
import { inngest, jobReadyEvent, webhookReceivedEvent } from '@/lib/inngest/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  if (!isCronAuthorized(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const result = await recoverAndPublish(async (due) => {
    await inngest.send(
      due.map((d) =>
        d.table === 'webhook_inbox'
          ? webhookReceivedEvent(d.id, d.instagramAccountId, d.generation)
          : jobReadyEvent(d.id, d.instagramAccountId, d.generation, d.jobType)
      )
    );
  });

  return Response.json({ ok: true, ...result, at: new Date().toISOString() });
}
