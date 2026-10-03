/**
 * Shared domain types - DB rows, job payloads, Meta webhook shapes.
 */

// ── Automations ─────────────────────────────────────────────────────────────

export type AutomationType = 'comment_dm' | 'dm_reply' | 'story_reply';
export type DMResponseType = 'text' | 'card' | 'ask_follow' | 'lead_form';

export interface CardButton {
  id: string;
  title: string;
  link: string;
}

export interface DMResponse {
  id: string;
  type: DMResponseType;
  content: string;
  buttonTitle?: string;
  buttonLink?: string;
  cardImage?: string;
  cardTitle?: string;
  cardSubtitle?: string;
  cardButtons?: CardButton[];
}

export interface AutomationRow {
  id: string;
  user_id: string;
  instagram_account_id: string;
  name: string;
  type: AutomationType;
  is_active: boolean;
  post_id: string | null;
  post_thumbnail_url: string | null;
  post_caption: string | null;
  keywords: string[] | null;
  comment_reply_options: string[];
  dm_opening_message_enabled: boolean;
  dm_opening_message: string;
  dm_opening_message_button_title: string | null;
  dm_opening_message_button_link: string | null;
  ask_to_follow_enabled: boolean;
  ask_to_follow_message: string;
  ask_to_follow_visit_profile_button: string;
  ask_to_follow_confirm_button: string;
  dm_responses: DMResponse[];
  total_dms_sent: number;
  created_at: string;
  updated_at: string;
}

export interface InstagramAccountRow {
  id: string;
  user_id: string;
  instagram_user_id: string;
  username: string | null;
  name: string | null;
  profile_picture_url: string | null;
  access_token_encrypted: string;
  token_expires_at: string | null;
  is_active: boolean;
  paused_until: string | null;
  pause_reason: string | null;
  created_at: string;
  updated_at: string;
}

// ── Job queue ───────────────────────────────────────────────────────────────

export interface AutoDmJobPayload {
  automationId: string;
  instagramAccountId: string; // internal DB UUID
  igAccountIgsid: string; // Meta IGSID of the creator's account
  triggerType: 'comment' | 'dm' | 'story_reply' | 'dm_reply_followup';
  triggerUserId: string; // IGSID of the commenter / DM sender
  triggerUsername?: string | null; // for {username} personalization (comments carry it; DMs don't)
  triggerEventId: string; // comment ID or message mid
  triggerTimestamp: number; // unix epoch ms
  postId: string | null;
  commentText: string | null;
  messageText: string | null;
  // 2-step flow (opening DM → quick-reply tap → follow-up)
  isFollowUp?: boolean;
  sessionId?: string;
  sessionStep?: number;
}

export interface JobQueueRow {
  id: string;
  job_type: 'auto_dm' | 'follow_up';
  payload: AutoDmJobPayload;
  dedupe_key: string;
  status: JobStatus;
  run_after: string;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  locked_at: string | null;
  inbox_id: string | null;
  workflow_run_id: string | null;
  publish_state: PublishState;
  publish_generation: number;
  publish_lease_until: string | null;
  next_publish_at: string;
  lease_owner: string | null;
  lease_version: number;
  lease_expires_at: string | null;
  next_retry_at: string | null;
  created_at: string;
  updated_at: string;
}

export type JobStatus = 'pending' | 'processing' | 'suspended' | 'done' | 'failed' | 'skipped' | 'uncertain';
export type PublishState = 'pending' | 'publishing' | 'published' | 'failed';

// ── Durable inbox / outbound actions ────────────────────────────────────────

/** One supported Meta event, split out of a webhook envelope. */
export type NormalizedWebhookEvent =
  | { kind: 'comment'; igAccountIgsid: string; entryTime: number; comment: MetaCommentChangeValue }
  | { kind: 'message' | 'postback'; igAccountIgsid: string; messaging: MetaWebhookMessaging };

export interface WebhookInboxRow {
  id: string;
  instagram_account_id: string;
  event_key: string;
  event_kind: NormalizedWebhookEvent['kind'];
  payload: NormalizedWebhookEvent;
  state: 'received' | 'processing' | 'processed' | 'ignored' | 'failed';
  occurred_at: string | null;
  received_at: string;
  publish_state: PublishState;
  publish_generation: number;
  publish_lease_until: string | null;
  next_publish_at: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export type OutboundActionState = 'pending' | 'dispatching' | 'accepted' | 'skipped' | 'failed' | 'uncertain';

export interface OutboundActionRow {
  id: string;
  job_id: string;
  instagram_account_id: string;
  action_key: string;
  action_kind: 'public_reply' | 'private_reply' | 'dm';
  recipient_ref: string;
  message_snapshot: Record<string, unknown>;
  state: OutboundActionState;
  provider_message_id: string | null;
  dispatched_at: string | null;
  next_attempt_at: string | null;
  error_class: string | null;
  last_error: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
}

// ── Meta webhook payloads ───────────────────────────────────────────────────

export interface MetaWebhookBody {
  object: 'instagram' | 'page';
  entry: MetaWebhookEntry[];
}

export interface MetaWebhookEntry {
  id: string; // IGSID of the business account
  time: number; // unix seconds
  changes?: MetaWebhookChange[];
  messaging?: MetaWebhookMessaging[];
}

export interface MetaWebhookChange {
  field: 'comments' | 'mentions' | 'story_insights' | string;
  value: MetaCommentChangeValue;
}

export interface MetaCommentChangeValue {
  from: { id: string; username?: string };
  media: { id: string };
  id: string; // comment ID
  text: string;
  timestamp?: number; // unix seconds - Meta may omit on IG comment webhooks
  parent_id?: string;
}

export interface MetaWebhookMessaging {
  sender: { id: string };
  recipient: { id: string };
  timestamp: number; // unix ms
  message?: {
    mid: string;
    text?: string;
    is_echo?: boolean;
    quick_reply?: { payload: string };
    /** Present when the message is a reply to one of the account's stories. */
    reply_to?: { story?: { id?: string; url?: string }; mid?: string };
  };
  read?: { watermark: number };
  delivery?: { watermark: number; seq?: number };
  postback?: { mid?: string; payload: string; title: string };
}

// ── Instagram OAuth responses ───────────────────────────────────────────────

export interface IgShortLivedTokenResponse {
  access_token: string;
  user_id: string;
  permissions?: string[];
}

export interface IgLongLivedTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number; // seconds (~60 days)
}

export interface IgUserProfile {
  user_id: string;
  username: string;
  name?: string;
  profile_picture_url?: string;
}
