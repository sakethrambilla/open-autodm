/**
 * Maintenance endpoint, called by Supabase pg_cron with Authorization: Bearer
 * CRON_SECRET and a JSON body { "mode": "refresh" } (hourly) or
 * { "mode": "cleanup" } (daily). Never sends Instagram messages.
 */

import { z } from 'zod';
import { isCronAuthorized } from '@/lib/auth';
import { refreshExpiringTokens, runCleanup } from '@/lib/automation/maintenance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const BodySchema = z.object({ mode: z.enum(['refresh', 'cleanup']) });

export async function POST(request: Request): Promise<Response> {
  if (!isCronAuthorized(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const parsed = BodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: 'Body must be {"mode":"refresh"} or {"mode":"cleanup"}' }, { status: 400 });
  }

  if (parsed.data.mode === 'refresh') {
    return Response.json({ ok: true, mode: 'refresh', ...(await refreshExpiringTokens()) });
  }
  return Response.json({ ok: true, mode: 'cleanup', deleted: await runCleanup() });
}
