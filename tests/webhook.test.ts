import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;

// Minimal in-memory stand-in for the supabase-js query builder.
class FakeDb {
  tables: Record<string, Row[]> = {};
  unique: Record<string, string[][]> = {
    webhook_inbox: [['instagram_account_id', 'event_key']],
    job_queue: [['dedupe_key']],
  };
  failOn = new Set<string>();
  rpcCalls: Array<{ fn: string; args: unknown }> = [];
  private seq = 0;

  from(table: string): Query {
    this.tables[table] ??= [];
    return new Query(this, table);
  }

  async rpc(fn: string, args: unknown): Promise<{ data: null; error: null }> {
    this.rpcCalls.push({ fn, args });
    return { data: null, error: null };
  }

  nextId(): string {
    this.seq += 1;
    return `00000000-0000-4000-8000-${String(this.seq).padStart(12, '0')}`;
  }
}

type Result = { data: unknown; error: { code?: string; message: string } | null };

class Query {
  private filters: Array<(r: Row) => boolean> = [];
  private op: 'select' | 'insert' | 'upsert' | 'update' = 'select';
  private rows: Row[] = [];
  private ignoreDuplicates = false;
  private patch: Row = {};
  private mode: 'many' | 'maybeSingle' | 'single' = 'many';

  constructor(private db: FakeDb, private table: string) {}

  select(): this { return this; }
  order(): this { return this; }
  eq(col: string, val: unknown): this { this.filters.push((r) => r[col] === val); return this; }
  in(col: string, vals: unknown[]): this { this.filters.push((r) => vals.includes(r[col])); return this; }
  insert(rows: Row | Row[]): this { this.op = 'insert'; this.rows = [rows].flat(); return this; }
  upsert(rows: Row | Row[], opts?: { ignoreDuplicates?: boolean }): this {
    this.op = 'upsert'; this.rows = [rows].flat(); this.ignoreDuplicates = !!opts?.ignoreDuplicates; return this;
  }
  update(patch: Row): this { this.op = 'update'; this.patch = patch; return this; }
  maybeSingle(): this { this.mode = 'maybeSingle'; return this; }
  single(): this { this.mode = 'single'; return this; }

  then<A, B>(ok?: (v: Result) => A, fail?: (e: unknown) => B): Promise<A | B> {
    return Promise.resolve(this.run()).then(ok, fail);
  }

  private run(): Result {
    if (this.db.failOn.has(this.table)) return { data: null, error: { code: 'XX000', message: 'connection reset' } };
    const table = this.db.tables[this.table]!;
    let out: Row[];
    if (this.op === 'select') {
      out = table.filter((r) => this.filters.every((f) => f(r)));
    } else if (this.op === 'update') {
      out = table.filter((r) => this.filters.every((f) => f(r)));
      out.forEach((r) => Object.assign(r, this.patch));
    } else {
      out = [];
      for (const row of this.rows) {
        const clash = (this.db.unique[this.table] ?? []).some((cols) =>
          table.some((r) => cols.every((c) => r[c] === row[c]))
        );
        if (clash) {
          if (this.op === 'upsert' && this.ignoreDuplicates) continue;
          return { data: null, error: { code: '23505', message: 'duplicate key value' } };
        }
        const stored = { id: this.db.nextId(), ...row };
        table.push(stored);
        out.push(stored);
      }
    }
    if (this.mode === 'many') return { data: out, error: null };
    if (this.mode === 'single' && out.length !== 1) return { data: null, error: { message: 'not single' } };
    return { data: out[0] ?? null, error: null };
  }
}

const db = new FakeDb();
const SECRET = 'test-app-secret';

vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => db }));
vi.mock('@/lib/debugLog', () => ({ debugLog: () => undefined }));
vi.mock('@/lib/inngest/client', () => ({}));
vi.mock('@/lib/settings', () => ({
  getMetaSettings: async () => ({ metaAppSecret: SECRET, metaFbAppSecret: null, webhookVerifyToken: 'v' }),
}));

const { POST } = await import('@/app/api/webhook/route');
const { processInboxEvent } = await import('@/lib/automation/processWebhook');

const ACCOUNT_ID = 'acc-1';
const IGSID = '17841400000000001';

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('hex')}`;
}

function post(body: string, signature: string | null = sign(body)): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (signature) headers['x-hub-signature-256'] = signature;
  return POST(new Request('http://localhost/api/webhook', { method: 'POST', headers, body }));
}

function commentEnvelope(entryId = IGSID, commentId = 'c-1', text = 'send LINK please'): string {
  return JSON.stringify({
    object: 'instagram',
    entry: [{
      id: entryId,
      time: Math.floor(Date.now() / 1000),
      changes: [{ field: 'comments', value: { id: commentId, text, from: { id: 'fan-1', username: 'fan' }, media: { id: 'media-1' } } }],
    }],
  });
}

beforeEach(() => {
  db.tables = {
    instagram_accounts: [{ id: ACCOUNT_ID, instagram_user_id: IGSID, is_active: true }],
    webhook_inbox: [],
    job_queue: [],
    automations: [],
    automation_sessions: [],
  };
  db.failOn.clear();
  db.rpcCalls = [];
});

describe('POST /api/webhook receipt', () => {
  it('rejects an invalid HMAC without storing anything', async () => {
    const body = commentEnvelope();
    const res = await post(body, sign(body, 'wrong-secret'));
    expect(res.status).toBe(403);
    expect(db.tables['webhook_inbox']).toHaveLength(0);
  });

  it('rejects a missing signature without storing anything', async () => {
    const res = await post(commentEnvelope(), null);
    expect(res.status).toBe(403);
    expect(db.tables['webhook_inbox']).toHaveLength(0);
  });

  it('stores a valid event before acknowledging, with an account-scoped key', async () => {
    const res = await post(commentEnvelope());
    expect(res.status).toBe(200);
    expect(db.tables['webhook_inbox']).toHaveLength(1);
    expect(db.tables['webhook_inbox']![0]).toMatchObject({
      instagram_account_id: ACCOUNT_ID,
      event_key: 'comment:c-1',
      event_kind: 'comment',
    });
  });

  it('treats a duplicate delivery as a successful no-op', async () => {
    const body = commentEnvelope();
    expect((await post(body)).status).toBe(200);
    expect((await post(body)).status).toBe(200);
    expect(db.tables['webhook_inbox']).toHaveLength(1);
  });

  it('does not store or act on events for unknown accounts', async () => {
    const res = await post(commentEnvelope('999'));
    expect(res.status).toBe(200);
    expect(db.tables['webhook_inbox']).toHaveLength(0);
    expect(db.tables['job_queue']).toHaveLength(0);
  });

  it('does not match campaigns or enqueue jobs in the receiver', async () => {
    db.tables['automations'] = [{ id: 'auto-1', instagram_account_id: ACCOUNT_ID, type: 'comment_dm', is_active: true, post_id: null, keywords: ['link'] }];
    await post(commentEnvelope());
    expect(db.tables['job_queue']).toHaveLength(0);
  });

  it('returns 5xx when the inbox write fails', async () => {
    db.failOn.add('webhook_inbox');
    const res = await post(commentEnvelope());
    expect(res.status).toBeGreaterThanOrEqual(500);
  });

  it('returns 5xx when the account lookup fails', async () => {
    db.failOn.add('instagram_accounts');
    const res = await post(commentEnvelope());
    expect(res.status).toBeGreaterThanOrEqual(500);
  });

  it('rejects oversized bodies before storing', async () => {
    const body = JSON.stringify({ object: 'instagram', entry: [], pad: 'x'.repeat(300 * 1024) });
    const res = await post(body);
    expect(res.status).toBe(413);
    expect(db.tables['webhook_inbox']).toHaveLength(0);
  });

  it('acknowledges unsupported signed events without storing', async () => {
    const body = JSON.stringify({
      object: 'instagram',
      entry: [{ id: IGSID, time: 1, messaging: [{ sender: { id: IGSID }, recipient: { id: 'x' }, timestamp: Date.now(), message: { mid: 'm-echo', is_echo: true } }] }],
    });
    expect((await post(body)).status).toBe(200);
    expect(db.tables['webhook_inbox']).toHaveLength(0);
  });
});

describe('processInboxEvent', () => {
  const SESSION_ID = '11111111-2222-4333-8444-555555555555';

  function postbackEvent(withMid: boolean) {
    return {
      kind: 'postback' as const,
      igAccountIgsid: IGSID,
      messaging: {
        sender: { id: 'fan-1' },
        recipient: { id: IGSID },
        timestamp: Date.now(),
        postback: { ...(withMid ? { mid: 'pb-1' } : {}), payload: `SESSION_${SESSION_ID}_STEP_2`, title: 'Yes' },
      },
    };
  }

  beforeEach(() => {
    db.tables['automation_sessions'] = [{
      id: SESSION_ID, automation_id: 'auto-1', completed: false, expires_at: new Date(Date.now() + 3600_000).toISOString(),
    }];
  });

  it('replaying a postback returns the existing follow-up job', async () => {
    const event = postbackEvent(false);
    const first = await processInboxEvent(ACCOUNT_ID, event);
    const second = await processInboxEvent(ACCOUNT_ID, event);
    expect(first.created).toHaveLength(1);
    expect(second.created).toHaveLength(0);
    expect(second.existing).toEqual(first.created);
    expect(db.tables['job_queue']).toHaveLength(1);
  });

  it('replaying a quick-reply session tap is idempotent', async () => {
    const event = {
      kind: 'message' as const,
      igAccountIgsid: IGSID,
      messaging: {
        sender: { id: 'fan-1' }, recipient: { id: IGSID }, timestamp: Date.now(),
        message: { mid: 'm-qr-1', text: 'Yes', quick_reply: { payload: `SESSION_${SESSION_ID}_STEP_2` } },
      },
    };
    await processInboxEvent(ACCOUNT_ID, event);
    const replay = await processInboxEvent(ACCOUNT_ID, event);
    expect(replay.existing).toHaveLength(1);
    expect(db.tables['job_queue']).toHaveLength(1);
  });

  it('creates one initial private reply per account/comment across overlapping campaigns', async () => {
    db.tables['automations'] = [
      { id: 'auto-a', instagram_account_id: ACCOUNT_ID, type: 'comment_dm', is_active: true, post_id: null, keywords: ['link'], created_at: '2026-01-01' },
      { id: 'auto-b', instagram_account_id: ACCOUNT_ID, type: 'comment_dm', is_active: true, post_id: 'media-1', keywords: ['link'], created_at: '2026-01-02' },
    ];
    const event = {
      kind: 'comment' as const,
      igAccountIgsid: IGSID,
      entryTime: Math.floor(Date.now() / 1000),
      comment: { id: 'c-9', text: 'LINK', from: { id: 'fan-1' }, media: { id: 'media-1' } },
    };
    const first = await processInboxEvent(ACCOUNT_ID, event);
    const replay = await processInboxEvent(ACCOUNT_ID, event);
    expect(first.created).toHaveLength(1);
    expect(replay.created).toHaveLength(0);
    expect(db.tables['job_queue']).toHaveLength(1);
  });

  it('throws on database errors instead of reporting no work', async () => {
    db.failOn.add('automation_sessions');
    await expect(processInboxEvent(ACCOUNT_ID, postbackEvent(true))).rejects.toThrow();
  });
});
