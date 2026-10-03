/**
 * Scheduled maintenance shared by /api/cron/maintenance: locked Instagram
 * token refresh (hourly) and bounded cleanup (daily). Never sends messages.
 */

import { randomUUID } from 'node:crypto';
import { createServiceClient } from '@/lib/supabase/service';
import { refreshLongLivedToken } from '@/lib/instagram/oauth';
import { decrypt, encrypt } from '@/lib/crypto';
import { getEnv } from '@/lib/env';
import { createLogger } from '@/lib/logger';
import { debugLog } from '@/lib/debugLog';
import type { InstagramAccountRow } from '@/lib/types';

const logger = createLogger('maintenance');

const REFRESH_LOCK = 'token_refresh';
const REFRESH_LOCK_SECONDS = 600;
const REFRESH_WINDOW_MS = 10 * 24 * 3600_000;

/** Runs `fn` under a named lease lock; returns null without running when another holder has it. */
async function withLock<T>(name: string, seconds: number, fn: () => Promise<T>): Promise<T | null> {
  const db = createServiceClient();
  const owner = randomUUID();
  const { data, error } = await db.rpc('try_maintenance_lock', { p_name: name, p_owner: owner, p_seconds: seconds });
  if (error) throw new Error(`try_maintenance_lock failed: ${error.message}`);
  if (data !== true) return null;
  try {
    return await fn();
  } finally {
    const { error: releaseError } = await db.rpc('release_maintenance_lock', { p_name: name, p_owner: owner });
    if (releaseError) logger.warn({ err: releaseError }, 'release_maintenance_lock failed; lease will expire');
  }
}

export type RefreshResult = { status: 'locked' } | { status: 'ok'; refreshed: number; failed: number };

/** Refreshes active tokens expiring within 10 days. Already-expired tokens need a reconnect. */
export async function refreshExpiringTokens(): Promise<RefreshResult> {
  const result = await withLock(REFRESH_LOCK, REFRESH_LOCK_SECONDS, async () => {
    const env = getEnv();
    const db = createServiceClient();
    const now = Date.now();
    const { data: accounts, error } = await db
      .from('instagram_accounts')
      .select('*')
      .eq('is_active', true)
      .not('token_expires_at', 'is', null)
      .gt('token_expires_at', new Date(now).toISOString())
      .lt('token_expires_at', new Date(now + REFRESH_WINDOW_MS).toISOString());
    if (error) throw new Error(`instagram_accounts lookup failed: ${error.message}`);

    let refreshed = 0;
    let failed = 0;
    for (const account of (accounts ?? []) as InstagramAccountRow[]) {
      try {
        const current = decrypt(account.access_token_encrypted, env.TOKEN_ENCRYPTION_KEY);
        const refreshedToken = await refreshLongLivedToken(current);
        if ('error' in refreshedToken) {
          failed += 1;
          debugLog('cron', 'warn', 'token_refresh', 'error',
            `Token refresh failed for @${account.username ?? account.id} (${refreshedToken.error}, HTTP ${refreshedToken.status})`,
            { accountId: account.id });
          continue;
        }
        const { error: updateError } = await db
          .from('instagram_accounts')
          .update({
            access_token_encrypted: encrypt(refreshedToken.access_token, env.TOKEN_ENCRYPTION_KEY),
            token_expires_at: new Date(Date.now() + refreshedToken.expires_in * 1000).toISOString(),
          })
          .eq('id', account.id);
        if (updateError) throw new Error(`instagram_accounts update failed: ${updateError.message}`);
        refreshed += 1;
        debugLog('cron', 'info', 'token_refresh', 'ok', `Token auto-refreshed for @${account.username ?? account.id}`, {
          accountId: account.id,
          daysRemaining: Math.floor(refreshedToken.expires_in / 86400),
        });
      } catch (err) {
        failed += 1;
        logger.warn({ err, accountId: account.id }, 'Token refresh attempt errored');
      }
    }
    return { refreshed, failed };
  });
  return result ? { status: 'ok', ...result } : { status: 'locked' };
}

const CLEANUP_BATCH = 1000;
const CLEANUP_MAX_BATCHES = 10;

/** Repeats bounded cleanup batches until one deletes nothing or the per-run cap is hit. */
export async function runCleanup(): Promise<Record<string, number>> {
  const db = createServiceClient();
  const totals: Record<string, number> = {};
  for (let i = 0; i < CLEANUP_MAX_BATCHES; i += 1) {
    const { data, error } = await db.rpc('cleanup_batch', { p_limit: CLEANUP_BATCH });
    if (error) throw new Error(`cleanup_batch failed: ${error.message}`);
    const counts = (data ?? {}) as Record<string, number>;
    let touched = 0;
    for (const [key, n] of Object.entries(counts)) {
      totals[key] = (totals[key] ?? 0) + n;
      touched += n;
    }
    if (touched === 0) break;
  }
  return totals;
}
