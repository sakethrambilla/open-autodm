/**
 * Meta Graph API client for Instagram messaging.
 *
 * Battle-tested against the live Instagram API. Key facts this
 * module encodes (learned the hard way - do not "simplify" them away):
 *
 *  - Instagram Business Login tokens call graph.instagram.com, NOT graph.facebook.com.
 *  - Button templates (postback buttons) work on graph.instagram.com with
 *    Instagram Login user access tokens - used for the 2-step quick-reply flow.
 *  - Postback payloads carry "SESSION_{uuid}_STEP_{n}" - routing is ALWAYS by
 *    payload, never by visible button text.
 *  - Access tokens are decrypted at call time and never logged.
 */

import { createLogger } from '@/lib/logger';
import { debugLog } from '@/lib/debugLog';
import { classifyMetaError, UnknownOutcomeError } from '@/lib/instagram/errors';

const logger = createLogger('instagram');

export const META_API_VERSION = 'v23.0';
const META_GRAPH_BASE = `https://graph.instagram.com/${META_API_VERSION}`;
export const META_REQUEST_TIMEOUT_MS = 10_000;

interface MetaSendMessageResponse {
  recipient_id?: string;
  message_id?: string;
  id?: string;
}

interface MetaErrorResponse {
  error?: {
    message: string;
    type: string;
    code: number;
    error_subcode?: number;
    fbtrace_id?: string;
  };
}

export interface QuickReply {
  /** Visible button label - Meta limit: 20 characters */
  title: string;
  /** Hidden payload: "SESSION_{uuid}_STEP_{n}". The routing key. */
  payload: string;
}

/**
 * Who receives the message.
 *
 *  - { id }        → general messaging (requires the 24h engagement window)
 *  - { commentId } → a PRIVATE REPLY to a comment. This is Meta's purpose-built
 *    comment-to-DM channel: its own allowance (750 private replies/hour,
 *    separate from the ~200/h messaging cap) and it is valid for 7 days after
 *    the comment. Always prefer this for comment-triggered opening DMs.
 */
export type DmRecipient = { id: string } | { commentId: string };

function recipientJson(recipient: DmRecipient): Record<string, string> {
  return 'commentId' in recipient ? { comment_id: recipient.commentId } : { id: recipient.id };
}

function recipientLabel(recipient: DmRecipient): string {
  return 'commentId' in recipient ? `comment ${recipient.commentId} (private reply)` : recipient.id;
}

/**
 * POSTs one send and returns Meta's message/comment ID. Throws a classified
 * MetaApiError only when Meta explicitly rejected the request; a timeout,
 * reset, unreadable body or 5xx without a specific error code throws
 * UnknownOutcomeError because the message may already have been delivered.
 */
async function postSend(context: string, url: string, body: unknown): Promise<string> {
  let res: Response;
  let data: MetaSendMessageResponse & MetaErrorResponse;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(META_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new UnknownOutcomeError(`${context}: no response from Meta (${err instanceof Error ? err.message : String(err)})`);
  }
  try {
    data = (await res.json()) as MetaSendMessageResponse & MetaErrorResponse;
  } catch {
    throw new UnknownOutcomeError(`${context}: unreadable Meta response (HTTP ${res.status})`);
  }

  if (!res.ok) {
    const code = data.error?.code;
    logger.error({ context, status: res.status, metaCode: code, metaMessage: data.error?.message }, 'Meta send failed');
    // Code 1 is Meta's generic "unknown error": no proof the send was rejected.
    if (res.status >= 500 && (code === undefined || code === 1)) {
      throw new UnknownOutcomeError(`${context}: Meta HTTP ${res.status} without a definite rejection`);
    }
    const message = data.error?.message ?? `Unknown Meta API error (${context}, HTTP ${res.status})`;
    throw classifyMetaError(message, code, data.error?.error_subcode);
  }

  const id = data.message_id ?? data.id;
  if (!id) throw new UnknownOutcomeError(`${context}: Meta accepted the request but returned no ID`);
  return id;
}

/** Sends a text DM (optionally with a postback button via button template). */
export async function sendInstagramDm(
  igAccountIgsid: string,
  recipient: DmRecipient,
  messageText: string,
  accessToken: string,
  quickReply?: QuickReply
): Promise<string> {
  let messageBody: Record<string, unknown>;
  if (quickReply?.title.trim()) {
    messageBody = {
      attachment: {
        type: 'template',
        payload: {
          template_type: 'button',
          text: messageText.slice(0, 640), // button template text limit
          buttons: [
            {
              type: 'postback',
              title: quickReply.title.trim().slice(0, 20),
              payload: quickReply.payload,
            },
          ],
        },
      },
    };
  } else {
    messageBody = { text: messageText };
  }

  const to = recipientLabel(recipient);
  debugLog('instagram', 'info', 'dm_send_attempt', 'processing', `Sending DM to ${to}`, {
    igAccountIgsid,
    recipient: to,
    hasQuickReply: !!quickReply,
    messagePreview: messageText.slice(0, 80),
  });

  let messageId: string;
  try {
    messageId = await postSend('sendInstagramDm', `${META_GRAPH_BASE}/${igAccountIgsid}/messages?access_token=${accessToken}`, {
      recipient: recipientJson(recipient),
      message: messageBody,
    });
  } catch (err) {
    debugLog('instagram', 'error', 'dm_send_failed', 'error',
      `DM to ${to} FAILED - ${err instanceof Error ? err.message : String(err)}`,
      { igAccountIgsid, recipient: to });
    throw err;
  }

  debugLog('instagram', 'info', 'dm_sent', 'ok', `DM sent to ${to} - messageId=${messageId}`, {
    igAccountIgsid,
    recipient: to,
    messageId,
  });
  return messageId;
}

/**
 * Sends a DM as a button template with a single tappable web_url LINK button -
 * far cleaner than pasting a raw URL into the text.
 *
 * IMPORTANT (learned from production tools): Meta occasionally rejects button
 * templates for certain recipients/URL combinations. Callers should catch an
 * explicit MetaApiError (never UnknownOutcomeError) and fall back to
 * sendInstagramDm with the link inline.
 */
export async function sendInstagramLinkButtonDm(
  igAccountIgsid: string,
  recipient: DmRecipient,
  messageText: string,
  buttonTitle: string,
  url: string,
  accessToken: string
): Promise<string> {
  const to = recipientLabel(recipient);
  const body = {
    recipient: recipientJson(recipient),
    message: {
      attachment: {
        type: 'template',
        payload: {
          template_type: 'button',
          text: messageText.slice(0, 640),
          buttons: [{ type: 'web_url', url, title: buttonTitle.trim().slice(0, 20) || 'Open link' }],
        },
      },
    },
  };

  debugLog('instagram', 'info', 'link_button_dm_attempt', 'processing', `Sending link-button DM to ${to}`, {
    igAccountIgsid,
    recipient: to,
    buttonTitle,
  });

  let messageId: string;
  try {
    messageId = await postSend('sendInstagramLinkButtonDm', `${META_GRAPH_BASE}/${igAccountIgsid}/messages?access_token=${accessToken}`, body);
  } catch (err) {
    debugLog('instagram', 'warn', 'link_button_dm_failed', 'error',
      `Link-button DM to ${to} failed - ${err instanceof Error ? err.message : String(err)}`,
      { igAccountIgsid, recipient: to });
    throw err;
  }

  debugLog('instagram', 'info', 'link_button_dm_sent', 'ok', `Link-button DM sent to ${to} - messageId=${messageId}`, {
    igAccountIgsid,
    recipient: to,
    messageId,
  });
  return messageId;
}

/** Posts a public reply to a comment and returns the reply's comment ID. */
export async function replyToComment(commentId: string, replyText: string, accessToken: string): Promise<string> {
  debugLog('instagram', 'info', 'comment_reply_attempt', 'processing', `Replying to comment ${commentId}`, {
    commentId,
    replyPreview: replyText.slice(0, 80),
  });

  let replyId: string;
  try {
    replyId = await postSend('replyToComment', `${META_GRAPH_BASE}/${commentId}/replies`, {
      message: replyText,
      access_token: accessToken,
    });
  } catch (err) {
    debugLog('instagram', 'warn', 'comment_reply_failed', 'error',
      `Comment reply to ${commentId} failed - ${err instanceof Error ? err.message : String(err)}`, { commentId });
    throw err;
  }
  debugLog('instagram', 'info', 'comment_reply_sent', 'ok', `Public reply posted to comment ${commentId}`, { commentId });
  return replyId;
}

/** Sends the ask-to-follow generic template (Visit Profile + confirm postback). */
export async function sendAskToFollowDm(
  igAccountIgsid: string,
  recipientIgsid: string,
  accessToken: string,
  options: {
    message: string;
    creatorUsername: string;
    visitProfileButtonTitle: string;
    confirmButtonTitle: string;
    confirmPayload: string;
  }
): Promise<string> {
  // Generic template title limit: 80 chars
  const title = options.message.length <= 80 ? options.message : options.message.slice(0, 77) + '…';

  const body = {
    recipient: { id: recipientIgsid },
    message: {
      attachment: {
        type: 'template',
        payload: {
          template_type: 'generic',
          elements: [
            {
              title,
              buttons: [
                {
                  type: 'web_url',
                  url: `https://www.instagram.com/${options.creatorUsername}/`,
                  title: options.visitProfileButtonTitle.slice(0, 20),
                },
                {
                  type: 'postback',
                  payload: options.confirmPayload,
                  title: options.confirmButtonTitle.slice(0, 20),
                },
              ],
            },
          ],
        },
      },
    },
  };

  let messageId: string;
  try {
    messageId = await postSend('sendAskToFollowDm', `${META_GRAPH_BASE}/${igAccountIgsid}/messages?access_token=${accessToken}`, body);
  } catch (err) {
    debugLog('instagram', 'error', 'ask_follow_dm_failed', 'error',
      `Ask-to-follow DM to ${recipientIgsid} FAILED - ${err instanceof Error ? err.message : String(err)}`,
      { igAccountIgsid, recipientIgsid });
    throw err;
  }
  debugLog('instagram', 'info', 'ask_follow_dm_sent', 'ok', `Ask-to-follow DM sent to ${recipientIgsid}`, {
    igAccountIgsid,
    recipientIgsid,
    messageId,
  });
  return messageId;
}

/** Sends a card (generic template) DM with image/title/subtitle/URL buttons. */
export async function sendInstagramCardDm(
  igAccountIgsid: string,
  recipientIgsid: string,
  accessToken: string,
  card: { imageUrl?: string; title?: string; subtitle?: string; buttons?: { title: string; url: string }[] }
): Promise<string> {
  const element: Record<string, unknown> = {
    title: (card.title ?? '').slice(0, 80) || ' ',
  };
  if (card.subtitle) element['subtitle'] = card.subtitle.slice(0, 80);
  if (card.imageUrl) element['image_url'] = card.imageUrl;
  if (card.buttons?.length) {
    element['buttons'] = card.buttons.slice(0, 3).map((btn) => ({
      type: 'web_url',
      url: btn.url,
      title: btn.title.slice(0, 20),
    }));
  }

  let messageId: string;
  try {
    messageId = await postSend('sendInstagramCardDm', `${META_GRAPH_BASE}/${igAccountIgsid}/messages?access_token=${accessToken}`, {
      recipient: { id: recipientIgsid },
      message: { attachment: { type: 'template', payload: { template_type: 'generic', elements: [element] } } },
    });
  } catch (err) {
    debugLog('instagram', 'error', 'card_dm_failed', 'error',
      `Card DM to ${recipientIgsid} FAILED - ${err instanceof Error ? err.message : String(err)}`,
      { igAccountIgsid, recipientIgsid });
    throw err;
  }
  debugLog('instagram', 'info', 'card_dm_sent', 'ok', `Card DM sent to ${recipientIgsid}`, {
    igAccountIgsid,
    recipientIgsid,
    messageId,
  });
  return messageId;
}

/**
 * Instagram User Profile API - available for any user who has messaged the
 * business (always our case: a button tap IS a message). Exposes username and
 * `is_user_follow_business` - the same follow signal commercial tools use for
 * "require follow" gates.
 */
export interface AudienceProfile {
  username: string | null;
  followsBusiness: boolean | null;
}

export async function getAudienceProfile(
  audienceIgsid: string,
  accessToken: string
): Promise<AudienceProfile | null> {
  try {
    const res = await fetch(
      `${META_GRAPH_BASE}/${audienceIgsid}?fields=username,is_user_follow_business&access_token=${accessToken}`,
      { signal: AbortSignal.timeout(META_REQUEST_TIMEOUT_MS) }
    );
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as MetaErrorResponse;
      debugLog('instagram', 'warn', 'profile_fetch_failed', 'error',
        `Profile fetch for ${audienceIgsid} failed - ${body.error?.code}: ${body.error?.message ?? `HTTP ${res.status}`}`,
        { audienceIgsid, httpStatus: res.status });
      return null;
    }
    const data = (await res.json()) as { username?: string; is_user_follow_business?: boolean };
    return {
      username: data.username ?? null,
      followsBusiness: typeof data.is_user_follow_business === 'boolean' ? data.is_user_follow_business : null,
    };
  } catch (err) {
    logger.warn({ audienceIgsid, err }, 'Profile fetch network error');
    return null;
  }
}

/**
 * Real follow check. Returns: true = follows · false = does not follow ·
 * null = unknown (API error / field unavailable). Callers must FAIL OPEN on
 * null - never block a legitimate person because the check itself hiccuped.
 */
export async function checkUserFollowsBusiness(
  audienceIgsid: string,
  accessToken: string
): Promise<boolean | null> {
  const profile = await getAudienceProfile(audienceIgsid, accessToken);
  const follows = profile?.followsBusiness ?? null;
  if (follows !== null) {
    debugLog('instagram', 'info', 'follow_check', 'ok',
      `Follow check: ${audienceIgsid} ${follows ? 'FOLLOWS' : 'does NOT follow'} the account`,
      { audienceIgsid, follows });
  }
  return follows;
}

/**
 * Subscribes an IG account to webhook fields. Meta requires this per-account
 * call in addition to the app-level webhook URL - without it, NO events fire.
 */
export const WEBHOOK_SUBSCRIBED_FIELDS = 'comments,messages,messaging_postbacks,message_reactions,message_edit';

export async function subscribeToWebhookFields(igUserId: string, accessToken: string): Promise<{ ok: boolean; body: string }> {
  const params = new URLSearchParams({ subscribed_fields: WEBHOOK_SUBSCRIBED_FIELDS, access_token: accessToken });
  const res = await fetch(`https://graph.instagram.com/${META_API_VERSION}/${igUserId}/subscribed_apps`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const body = await res.text();
  if (!res.ok) {
    logger.warn({ igUserId, status: res.status, body }, 'Webhook field subscription failed');
  } else {
    debugLog('oauth', 'info', 'webhook_subscribe', 'ok', `Webhook fields subscribed for ${igUserId}`, {
      fields: WEBHOOK_SUBSCRIBED_FIELDS,
    });
  }
  return { ok: res.ok, body };
}

export async function getSubscribedFields(igUserId: string, accessToken: string): Promise<{ ok: boolean; fields: string[]; raw: string }> {
  const res = await fetch(`https://graph.instagram.com/${META_API_VERSION}/${igUserId}/subscribed_apps?access_token=${accessToken}`);
  const raw = await res.text();
  if (!res.ok) return { ok: false, fields: [], raw };
  type SubscribedAppsResponse = { data?: Array<{ subscribed_fields?: string[] }>; subscribed_fields?: string[] };
  let parsed: SubscribedAppsResponse = {};
  try {
    parsed = JSON.parse(raw) as SubscribedAppsResponse;
  } catch {
    /* ignore */
  }
  const fields = parsed.data?.[0]?.subscribed_fields ?? parsed.subscribed_fields ?? [];
  return { ok: true, fields, raw };
}
