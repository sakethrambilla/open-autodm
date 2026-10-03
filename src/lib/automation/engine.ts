/**
 * Send outcome classification shared by every outbound action.
 *
 * Jobs are no longer drained in batches here: each job runs as its own
 * Inngest workflow (src/lib/inngest/functions.ts), and only that workflow
 * calls Meta. This module only decides what a failed send means.
 */

import { retryBackoffMs } from '@/lib/automation/queue';
import {
  AccountPausedMetaError,
  MetaApiError,
  NonRetryableMetaError,
  UnknownOutcomeError,
  META_RATE_LIMIT_CODES,
} from '@/lib/instagram/errors';

/** Explicitly rejected sends are retried at most this many times in total. */
export const MAX_SEND_ATTEMPTS = 3;

export type SendErrorOutcome =
  | { state: 'uncertain'; errorClass: 'unknown_outcome' }
  | { state: 'failed'; errorClass: 'account_paused' | 'terminal' | 'attempts_exhausted' }
  | { state: 'pending'; errorClass: 'meta_rate_limit' | 'retryable'; retryAt: Date };

/** `attempts` counts the dispatch that just failed. */
export function classifySendError(err: unknown, attempts: number): SendErrorOutcome {
  // Anything that is not an explicit Meta rejection may have been delivered.
  if (err instanceof UnknownOutcomeError || !(err instanceof MetaApiError)) {
    return { state: 'uncertain', errorClass: 'unknown_outcome' };
  }
  if (err instanceof AccountPausedMetaError) return { state: 'failed', errorClass: 'account_paused' };
  if (err instanceof NonRetryableMetaError) return { state: 'failed', errorClass: 'terminal' };
  if (attempts >= MAX_SEND_ATTEMPTS) return { state: 'failed', errorClass: 'attempts_exhausted' };
  if (err.code !== undefined && (META_RATE_LIMIT_CODES as readonly number[]).includes(err.code)) {
    return { state: 'pending', errorClass: 'meta_rate_limit', retryAt: new Date(Date.now() + 15 * 60_000) };
  }
  return { state: 'pending', errorClass: 'retryable', retryAt: new Date(Date.now() + retryBackoffMs(attempts)) };
}
