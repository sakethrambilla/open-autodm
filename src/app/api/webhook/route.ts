/**
 * Meta webhook endpoint.
 *
 * GET  → subscription verification challenge (Meta portal setup)
 * POST → live events (comments, DMs, postbacks)
 *
 * Contract with Meta:
 *  1. Body size is bounded and the HMAC-SHA256 signature is verified over the
 *     RAW bytes before anything else. Invalid → 403, no database writes.
 *  2. Each supported event is stored in webhook_inbox before 200 is returned.
 *     Storage failure → 5xx so Meta redelivers; duplicates are 200 no-ops.
 *  3. The receiver never matches campaigns or calls Meta. Stored events are
 *     published by ID for durable processing; anything left unpublished is
 *     picked up by recovery.
 */

import { getMetaSettings } from '@/lib/settings';
import { hmacSha256Hex, safeCompare } from '@/lib/crypto';
import { extractEvents, MAX_WEBHOOK_BODY_BYTES, publishInboxEvents, storeInboxEvents } from '@/lib/automation/inbox';
import '@/lib/inngest/client'; // registers the Inngest inbox publisher
import { createLogger } from '@/lib/logger';
import { debugLog } from '@/lib/debugLog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const logger = createLogger('webhook-route');

// ── GET /api/webhook - Meta verification challenge ──────────────────────────
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const mode = url.searchParams.get('hub.mode');
  const challenge = url.searchParams.get('hub.challenge');
  const verifyToken = url.searchParams.get('hub.verify_token');

  const settings = await getMetaSettings();

  if (mode === 'subscribe' && settings && verifyToken === settings.webhookVerifyToken) {
    debugLog('webhook', 'info', 'webhook_verify', 'ok', 'Meta webhook verification successful', {});
    return new Response(challenge ?? '', { status: 200 });
  }

  debugLog('webhook', 'warn', 'webhook_verify', 'error', 'Webhook verification failed - token mismatch or setup incomplete', {
    mode,
    configured: !!settings,
  });
  return Response.json({ error: 'Forbidden' }, { status: 403 });
}

// ── POST /api/webhook - live events ─────────────────────────────────────────
export async function POST(request: Request): Promise<Response> {
  const signature = request.headers.get('x-hub-signature-256');
  const declaredLength = Number(request.headers.get('content-length') ?? 0);
  if (declaredLength > MAX_WEBHOOK_BODY_BYTES) {
    return Response.json({ error: 'Payload too large' }, { status: 413 });
  }
  const bodyBuffer = Buffer.from(await request.arrayBuffer());
  if (bodyBuffer.byteLength > MAX_WEBHOOK_BODY_BYTES) {
    return Response.json({ error: 'Payload too large' }, { status: 413 });
  }

  debugLog('webhook', 'info', 'webhook_received', 'processing', 'POST /api/webhook received from Meta', {
    hasSignature: !!signature,
    bytes: bodyBuffer.byteLength,
  });

  if (!signature) {
    debugLog('webhook', 'error', 'signature_check', 'error', 'Missing x-hub-signature-256 header', {});
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

  const settings = await getMetaSettings();
  if (!settings) {
    // Setup wizard not completed - we cannot verify anything. Reject.
    debugLog('webhook', 'error', 'signature_check', 'error', 'Meta credentials not configured - complete the Setup Wizard first', {});
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Meta signs with the Instagram app secret for IG-Login apps and the
  // Facebook app secret for FB-Login apps. Accept a match against either
  // configured secret - avoids a config guess that silently kills webhooks.
  const signingSecrets = [settings.metaAppSecret, settings.metaFbAppSecret].filter(
    (s): s is string => Boolean(s)
  );
  const signatureValid = signingSecrets.some((secret) =>
    safeCompare(signature, `sha256=${hmacSha256Hex(secret, bodyBuffer)}`)
  );
  if (!signatureValid) {
    logger.warn({}, 'Webhook signature verification FAILED - rejecting');
    debugLog('webhook', 'error', 'signature_check', 'error',
      'HMAC-SHA256 signature mismatch - request rejected', {
        hint: 'If this keeps happening on real events, add your Facebook App Secret in the Setup Wizard - some Meta apps sign webhooks with it instead of the Instagram app secret.',
      });
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

  debugLog('webhook', 'info', 'signature_check', 'ok', 'HMAC-SHA256 signature verified', {});

  let events;
  try {
    events = extractEvents(JSON.parse(bodyBuffer.toString('utf8')));
  } catch {
    events = null;
  }
  if (!events) {
    // Signed but malformed - acknowledge so Meta doesn't retry forever.
    return Response.json({ status: 'ignored' }, { status: 200 });
  }

  let receipt;
  try {
    receipt = await storeInboxEvents(events);
  } catch (err) {
    logger.error({ err }, 'Webhook inbox persistence failed - returning 5xx for redelivery');
    debugLog('webhook', 'error', 'inbox_store', 'error',
      `Inbox persistence failed: ${err instanceof Error ? err.message : String(err)}`, {});
    return Response.json({ error: 'Storage unavailable' }, { status: 503 });
  }

  if (receipt.unknownAccount > 0) {
    debugLog('webhook', 'warn', 'ig_account_lookup', 'skipped', `${receipt.unknownAccount} event(s) for unknown or inactive IG accounts ignored`, {
      hint: 'Meta console "Test" button sends entry.id=0 (fake) - real comments from the connected account are required.',
    });
  }
  debugLog('webhook', 'info', 'inbox_store', 'ok', `Stored ${receipt.stored.length} event(s), ${receipt.duplicates} duplicate(s)`, {});

  await publishInboxEvents(receipt.stored.map((r) => ({ inboxId: r.id, instagramAccountId: r.instagramAccountId })));

  return Response.json({ status: 'ok' }, { status: 200 });
}
