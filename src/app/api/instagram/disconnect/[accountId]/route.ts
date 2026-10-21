/**
 * DELETE /api/instagram/disconnect/:accountId - deactivate a connected account.
 * Soft delete: the row is kept (token wiped, is_active=false) so its automations,
 * contacts and history survive; the OAuth callback upserts on instagram_user_id,
 * so reconnecting the same Instagram account reactivates this row.
 */

import { getAuthenticatedUser, unauthorized } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/service';
import { createLogger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const logger = createLogger('api:disconnect');

type RouteContext = { params: Promise<{ accountId: string }> };

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  const user = await getAuthenticatedUser(request);
  if (!user) return unauthorized();

  const { accountId } = await context.params;
  const db = createServiceClient();

  const { data: account, error: fetchError } = await db
    .from('instagram_accounts')
    .select('id, user_id, username')
    .eq('id', accountId)
    .eq('user_id', user.id)
    .single();

  if (fetchError || !account) {
    return Response.json({ error: 'Instagram account not found' }, { status: 404 });
  }

  const { error: updateError } = await db
    .from('instagram_accounts')
    .update({ is_active: false, access_token_encrypted: '', token_expires_at: null })
    .eq('id', accountId)
    .eq('user_id', user.id);

  if (updateError) {
    logger.error({ err: updateError, accountId }, 'Failed to disconnect account');
    return Response.json({ error: 'Failed to disconnect account' }, { status: 500 });
  }

  logger.info({ userId: user.id, username: account.username }, 'Instagram account disconnected');
  return Response.json({ success: true });
}
