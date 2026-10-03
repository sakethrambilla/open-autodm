/**
 * Setup Wizard API.
 *
 * GET  → current setup status + the exact values to paste into the Meta portal
 *        (webhook URL, verify token, OAuth redirect URI, Vault-backed
 *        pg_cron snippet that never contains the cron secret).
 * POST → save Meta App ID + App Secret (secret is AES-256-GCM encrypted
 *        before it touches the DB). Generates a webhook verify token on
 *        first save and PRESERVES it on later saves so Meta's existing
 *        webhook subscription keeps validating.
 */

import { z } from 'zod';
import { getAuthenticatedUser, unauthorized } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/service';
import { getMetaSettings, saveMetaSettings } from '@/lib/settings';
import { randomToken } from '@/lib/crypto';
import { getAppUrl, getEnv } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SaveSetupSchema = z.object({
  metaAppId: z.string().regex(/^\d{5,25}$/, 'Meta App ID must be numeric'),
  metaAppSecret: z.string().regex(/^[0-9a-f]{32}$/i, 'Meta App Secret must be 32 hex characters'),
  // Optional: some Meta apps sign webhooks with the Facebook app secret.
  metaFbAppSecret: z
    .string()
    .regex(/^[0-9a-f]{32}$/i, 'Facebook App Secret must be 32 hex characters')
    .optional()
    .or(z.literal('').transform(() => undefined)),
});

const CRON_JOB_NAMES = ['open-autodm-process-jobs', 'open-autodm-token-refresh', 'open-autodm-cleanup'] as const;

function cronCall(appUrl: string, path: string, body: string): string {
  return `select net.http_post(
    url := '${appUrl}${path}',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'open_autodm_cron_secret')
    ),
    body := '${body}'::jsonb,
    timeout_milliseconds := 55000
  );`;
}

/**
 * Idempotent pg_cron setup. The secret is stored once in Supabase Vault and
 * read at run time, so neither this output nor cron.job contains it.
 * cron.schedule with an existing name replaces that job, so re-running is safe.
 */
function cronSnippet(appUrl: string): string {
  const [processJobs, tokenRefresh, cleanup] = CRON_JOB_NAMES;
  return `-- Run in your Supabase project's SQL Editor. Safe to run again.
-- Replace YOUR_CRON_SECRET with your deployment's CRON_SECRET; it is stored
-- in Supabase Vault and never written into the schedules themselves.
create extension if not exists pg_cron;
create extension if not exists pg_net;

do $do$
declare v_id uuid;
begin
  select id into v_id from vault.secrets where name = 'open_autodm_cron_secret';
  if v_id is null then
    perform vault.create_secret('YOUR_CRON_SECRET', 'open_autodm_cron_secret');
  else
    perform vault.update_secret(v_id, 'YOUR_CRON_SECRET');
  end if;
end
$do$;

-- Recovery: republish due work every five minutes (empty passes create no Inngest runs).
select cron.schedule('${processJobs}', '*/5 * * * *', $$
  ${cronCall(appUrl, '/api/cron/process-jobs', '{}')}
$$);

-- Hourly token refresh.
select cron.schedule('${tokenRefresh}', '17 * * * *', $$
  ${cronCall(appUrl, '/api/cron/maintenance', '{"mode":"refresh"}')}
$$);

-- Daily cleanup (also prunes cron.job_run_details).
select cron.schedule('${cleanup}', '43 3 * * *', $$
  ${cronCall(appUrl, '/api/cron/maintenance', '{"mode":"cleanup"}')}
$$);`;
}

export async function GET(request: Request): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();

  const settings = await getMetaSettings();
  const appUrl = getAppUrl(request);

  // Read the raw row too - settings is null until fully configured, but a
  // partially-saved verify token should survive wizard re-entry.
  const db = createServiceClient();
  const { data: row } = await db
    .from('app_settings')
    .select('meta_app_id, webhook_verify_token, setup_completed')
    .eq('id', 1)
    .maybeSingle();

  return Response.json({
    configured: !!settings,
    metaAppId: (row?.meta_app_id as string | null) ?? null,
    webhookVerifyToken: (row?.webhook_verify_token as string | null) ?? null,
    webhookUrl: `${appUrl}/api/webhook`,
    oauthRedirectUri: `${appUrl}/api/instagram/callback`,
    appUrl,
    cronSnippet: cronSnippet(appUrl),
  });
}

export async function POST(request: Request): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = SaveSetupSchema.safeParse(body);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    return Response.json({ error: `Validation failed - ${detail}` }, { status: 400 });
  }

  try {
    // Ensure env is valid before accepting credentials (fail loudly, but with
    // the actual list of missing vars so the self-hoster can fix it).
    getEnv();

    // Preserve the existing verify token if one was generated before -
    // regenerating it would silently break the webhook registered in Meta.
    const db = createServiceClient();
    const { data: existing } = await db
      .from('app_settings')
      .select('webhook_verify_token')
      .eq('id', 1)
      .maybeSingle();

    const verifyToken = (existing?.webhook_verify_token as string | null) ?? randomToken(16);

    await saveMetaSettings({
      metaAppId: parsed.data.metaAppId,
      metaAppSecret: parsed.data.metaAppSecret,
      metaFbAppSecret: parsed.data.metaFbAppSecret ?? null,
      webhookVerifyToken: verifyToken,
    });

    const appUrl = getAppUrl(request);
    return Response.json({
      success: true,
      webhookVerifyToken: verifyToken,
      webhookUrl: `${appUrl}/api/webhook`,
      oauthRedirectUri: `${appUrl}/api/instagram/callback`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The single most common self-hosting mistake: migrations not applied yet.
    if (/app_settings/i.test(message) && /(find|exist|schema)/i.test(message)) {
      return Response.json(
        {
          error:
            'Database schema is missing - the migrations have not been applied to your Supabase project. ' +
            'Run: supabase link --project-ref <your-ref> && supabase db push, then try again.',
        },
        { status: 500 }
      );
    }
    return Response.json({ error: message }, { status: 500 });
  }
}
