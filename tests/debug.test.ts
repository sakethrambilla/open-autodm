import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;
type Call = { table: string; select?: string; in?: [string, unknown[]]; eq?: [string, unknown] };

// Records each query; returns canned rows per table.
class FakeDb {
  calls: Call[] = [];
  rows: Record<string, Row[]> = {};
  from(table: string) {
    const call: Call = { table };
    this.calls.push(call);
    const q = {
      select: (cols: string) => { call.select = cols; return q; },
      eq: (col: string, val: unknown) => { call.eq = [col, val]; return q; },
      in: (col: string, vals: unknown[]) => { call.in = [col, vals]; return q; },
      or: () => q,
      order: () => q,
      limit: () => q,
      then: (ok: (v: { data: Row[]; error: null }) => unknown) => Promise.resolve({ data: this.rows[table] ?? [], error: null }).then(ok),
    };
    return q;
  }
}

let db: FakeDb;
let user: { id: string } | null;
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => db }));
vi.mock('@/lib/auth', () => ({
  getAuthenticatedUser: async () => user,
  unauthorized: () => Response.json({ error: 'Unauthorized' }, { status: 401 }),
}));

const { GET } = await import('@/app/api/debug/events/route');

beforeEach(() => {
  db = new FakeDb();
  user = { id: 'owner-1' };
});

describe('debug events route', () => {
  it('rejects requests without a session', async () => {
    user = null;
    const res = await GET(new Request('http://x/api/debug/events'));
    expect(res.status).toBe(401);
    expect(db.calls).toHaveLength(0);
  });

  it('scopes state queries to the owner accounts and never selects content', async () => {
    db.rows['instagram_accounts'] = [{ id: 'acct-1' }];
    db.rows['outbound_actions'] = [{ id: 'a1', state: 'accepted', last_error: 'x'.repeat(1000) }];
    const res = await GET(new Request('http://x/api/debug/events'));
    const body = (await res.json()) as { actions: Row[] };

    expect(db.calls.find((c) => c.table === 'instagram_accounts')?.eq).toEqual(['user_id', 'owner-1']);
    for (const table of ['webhook_inbox', 'job_queue', 'outbound_actions']) {
      const call = db.calls.find((c) => c.table === table)!;
      expect(call.in?.[1]).toEqual(['acct-1']);
      expect(call.select).not.toMatch(/payload|message_snapshot|token|recipient_ref/);
    }
    expect((body.actions[0]!['last_error'] as string).length).toBe(300);
  });

  it('returns no state rows when the owner has no accounts', async () => {
    const res = await GET(new Request('http://x/api/debug/events'));
    expect(await res.json()).toEqual({ events: [], inbox: [], jobs: [], actions: [] });
    expect(db.calls.map((c) => c.table)).toEqual(['debug_events', 'instagram_accounts']);
  });
});
