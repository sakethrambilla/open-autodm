import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

const url = process.env['TEST_SUPABASE_URL'];
const serviceKey = process.env['TEST_SUPABASE_SERVICE_ROLE_KEY'];
const anonKey = process.env['TEST_SUPABASE_ANON_KEY'];
const configured = Boolean(url && serviceKey);

if (configured && url === process.env['NEXT_PUBLIC_SUPABASE_URL']) {
  throw new Error('TEST_SUPABASE_URL must point at a dedicated test project, not NEXT_PUBLIC_SUPABASE_URL');
}

const SERVICE_ONLY_RPCS: Array<[string, Record<string, unknown>]> = [
  ['claim_inbox_publication', { p_limit: 1 }],
  ['claim_job_publication', { p_limit: 1 }],
  ['claim_job', { p_job_id: '00000000-0000-0000-0000-000000000000', p_owner: 'test' }],
  ['begin_action_dispatch', { p_action_id: '00000000-0000-0000-0000-000000000000' }],
  ['recover_stale_leases', {}],
  ['try_maintenance_lock', { p_name: 'integration-probe', p_owner: 'test', p_seconds: 1 }],
  ['cleanup_batch', { p_limit: 1 }],
];

describe.skipIf(!configured)('durable processing schema (test Supabase project)', () => {
  const service = () => createClient(url!, serviceKey!, { auth: { persistSession: false } });

  it('service role can call the claim RPCs', async () => {
    for (const [fn, args] of SERVICE_ONLY_RPCS) {
      const { error } = await service().rpc(fn, args);
      expect(error, fn).toBeNull();
    }
  });

  it.skipIf(!anonKey)('anon cannot execute service-only RPCs', async () => {
    const anon = createClient(url!, anonKey!, { auth: { persistSession: false } });
    for (const [fn, args] of SERVICE_ONLY_RPCS) {
      const { error } = await anon.rpc(fn, args);
      expect(error, fn).not.toBeNull();
    }
  });

  it('maintenance lock admits one holder until released', async () => {
    const db = service();
    const name = `integration-lock-${Date.now()}`;
    const first = await db.rpc('try_maintenance_lock', { p_name: name, p_owner: 'a', p_seconds: 60 });
    const second = await db.rpc('try_maintenance_lock', { p_name: name, p_owner: 'b', p_seconds: 60 });
    expect([first.data, second.data]).toEqual([true, false]);
    await db.rpc('release_maintenance_lock', { p_name: name, p_owner: 'a' });
    expect((await db.rpc('try_maintenance_lock', { p_name: name, p_owner: 'b', p_seconds: 60 })).data).toBe(true);
    await db.rpc('release_maintenance_lock', { p_name: name, p_owner: 'b' });
  });
});
