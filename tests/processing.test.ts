import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encrypt } from '@/lib/crypto';

type Row = Record<string, unknown>;
type Result = { data: unknown; error: { code?: string; message: string } | null };

const KEY = 'a'.repeat(64);
const nowIso = (offsetMs = 0): string => new Date(Date.now() + offsetMs).toISOString();

// In-memory stand-in for the supabase-js query builder plus the RPCs the worker uses.
class FakeDb {
  tables: Record<string, Row[]> = {};
  unique: Record<string, string[][]> = {
    outbound_actions: [['job_id', 'action_key']],
    dm_sent_log: [['automation_id', 'trigger_event_id']],
    dm_jobs: [['automation_id', 'trigger_event_id']],
    automation_sessions: [['id']],
  };
  rateAllowed = true;
  private seq = 0;

  from(table: string): Query {
    this.tables[table] ??= [];
    return new Query(this, table);
  }

  nextId(): string {
    this.seq += 1;
    return `00000000-0000-4000-8000-${String(this.seq).padStart(12, '0')}`;
  }

  async rpc(fn: string, args: Record<string, unknown>): Promise<Result> {
    const jobs = this.tables['job_queue'] ?? [];
    const actions = this.tables['outbound_actions'] ?? [];
    const now = Date.now();
    switch (fn) {
      case 'claim_job': {
        const job = jobs.find((j) => j['id'] === args['p_job_id']);
        const claimable = job &&
          (['pending', 'suspended'].includes(job['status'] as string) ||
            (job['status'] === 'processing' && Date.parse(job['lease_expires_at'] as string) < now)) &&
          Date.parse(job['run_after'] as string) <= now;
        if (!job || !claimable) return { data: [], error: null };
        Object.assign(job, {
          status: 'processing', lease_owner: args['p_owner'], lease_version: (job['lease_version'] as number) + 1,
          lease_expires_at: nowIso(Number(args['p_lease_seconds'] ?? 300) * 1000),
        });
        return { data: [{ ...job }], error: null };
      }
      case 'begin_action_dispatch': {
        const a = actions.find((x) => x['id'] === args['p_action_id']);
        if (!a || a['state'] !== 'pending' || (a['next_attempt_at'] && Date.parse(a['next_attempt_at'] as string) > now)) {
          return { data: false, error: null };
        }
        Object.assign(a, { state: 'dispatching', dispatched_at: nowIso(), attempts: (a['attempts'] as number) + 1, next_attempt_at: null });
        return { data: true, error: null };
      }
      case 'complete_action_dispatch': {
        const a = actions.find((x) => x['id'] === args['p_action_id']);
        if (!a || a['state'] !== 'dispatching') return { data: false, error: null };
        Object.assign(a, {
          state: args['p_state'],
          provider_message_id: args['p_provider_message_id'] ?? a['provider_message_id'],
          error_class: args['p_error_class'] ?? null,
          last_error: args['p_error'] ?? null,
          next_attempt_at: args['p_state'] === 'pending' ? args['p_retry_at'] : null,
        });
        return { data: true, error: null };
      }
      case 'check_and_record_dm_rate_limit':
        return { data: [{ allowed: this.rateAllowed, current_count: 1, retry_after_seconds: 600 }], error: null };
      default:
        return { data: null, error: null };
    }
  }
}

class Query {
  private filters: Array<(r: Row) => boolean> = [];
  private op: 'select' | 'insert' | 'upsert' | 'update' | 'delete' = 'select';
  private rows: Row[] = [];
  private ignoreDuplicates = false;
  private patch: Row = {};
  private mode: 'many' | 'maybeSingle' | 'single' = 'many';

  constructor(private db: FakeDb, private table: string) {}

  select(): this { return this; }
  order(): this { return this; }
  limit(): this { return this; }
  eq(col: string, val: unknown): this { this.filters.push((r) => r[col] === val); return this; }
  neq(col: string, val: unknown): this { this.filters.push((r) => r[col] !== val); return this; }
  in(col: string, vals: unknown[]): this { this.filters.push((r) => vals.includes(r[col])); return this; }
  insert(rows: Row | Row[]): this { this.op = 'insert'; this.rows = [rows].flat(); return this; }
  upsert(rows: Row | Row[], opts?: { ignoreDuplicates?: boolean }): this {
    this.op = 'upsert'; this.rows = [rows].flat(); this.ignoreDuplicates = !!opts?.ignoreDuplicates; return this;
  }
  update(patch: Row): this { this.op = 'update'; this.patch = patch; return this; }
  delete(): this { this.op = 'delete'; return this; }
  maybeSingle(): this { this.mode = 'maybeSingle'; return this; }
  single(): this { this.mode = 'single'; return this; }

  then<A, B>(ok?: (v: Result) => A, fail?: (e: unknown) => B): Promise<A | B> {
    return Promise.resolve(this.run()).then(ok, fail);
  }

  private run(): Result {
    const table = this.db.tables[this.table]!;
    let out: Row[];
    if (this.op === 'select') {
      out = table.filter((r) => this.filters.every((f) => f(r)));
    } else if (this.op === 'update') {
      out = table.filter((r) => this.filters.every((f) => f(r)));
      out.forEach((r) => Object.assign(r, this.patch));
    } else if (this.op === 'delete') {
      out = table.filter((r) => this.filters.every((f) => f(r)));
      this.db.tables[this.table] = table.filter((r) => !out.includes(r));
    } else {
      out = [];
      for (const row of this.rows) {
        const clash = (this.db.unique[this.table] ?? []).find((cols) =>
          table.some((r) => cols.every((c) => row[c] !== undefined && r[c] === row[c]))
        );
        if (clash) {
          if (this.op === 'upsert' && !this.ignoreDuplicates) {
            const existing = table.find((r) => clash.every((c) => r[c] === row[c]))!;
            Object.assign(existing, row);
            out.push(existing);
            continue;
          }
          if (this.op === 'upsert') continue;
          return { data: null, error: { code: '23505', message: 'duplicate key value' } };
        }
        const stored: Row = { id: this.db.nextId(), ...row };
        if (this.table === 'outbound_actions') {
          Object.assign(stored, { state: 'pending', attempts: 0, next_attempt_at: null, provider_message_id: null, ...row });
        }
        table.push(stored);
        out.push(stored);
      }
    }
    const copy = out.map((r) => ({ ...r }));
    if (this.mode === 'many') return { data: copy, error: null };
    if (this.mode === 'single' && copy.length !== 1) return { data: null, error: { message: 'not single' } };
    return { data: copy[0] ?? null, error: null };
  }
}

const db = new FakeDb();

vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => db }));
vi.mock('@/lib/debugLog', () => ({ debugLog: () => undefined }));
vi.mock('@/lib/automation/contacts', () => ({ updateContactProfile: () => undefined, recordContactInteraction: () => undefined }));
vi.mock('@/lib/env', () => ({
  getEnv: () => ({ TOKEN_ENCRYPTION_KEY: KEY, AUTODM_DRY_RUN: false }),
}));

const { executeJob } = await import('@/lib/automation/processJob');

// ── Fake Meta transport ─────────────────────────────────────────────────────
type Behaviour = 'ok' | 'retryable' | 'terminal' | 'timeout';
let behaviours: Record<string, Behaviour[]> = {};
let sends: string[] = [];

function messageText(body: string): string {
  const parsed = JSON.parse(body) as { message?: { text?: string; attachment?: { payload?: { text?: string } } } };
  return parsed.message?.text ?? parsed.message?.attachment?.payload?.text ?? '?';
}

const fakeFetch = vi.fn(async (_url: string, init?: RequestInit): Promise<Response> => {
  if (init?.method !== 'POST') return Response.json({ username: 'fan', is_user_follow_business: true });
  const text = messageText(String(init?.body ?? '{}'));
  sends.push(text);
  const behaviour = behaviours[text]?.shift() ?? 'ok';
  if (behaviour === 'timeout') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  if (behaviour === 'retryable') {
    return Response.json({ error: { code: 2, message: 'Service temporarily unavailable', type: 'OAuthException' } }, { status: 503 });
  }
  if (behaviour === 'terminal') {
    return Response.json({ error: { code: 190, message: 'Invalid OAuth access token', type: 'OAuthException' } }, { status: 400 });
  }
  return Response.json({ recipient_id: 'fan-1', message_id: `mid-${text}-${sends.length}` });
});
vi.stubGlobal('fetch', fakeFetch);

// ── Fake Inngest step tools (memoized like real steps) ──────────────────────
function makeStep(onSleep: (id: string, ms: number) => void = () => undefined) {
  const memo = new Map<string, unknown>();
  return {
    memo,
    async run<T>(id: string, fn: () => Promise<T>): Promise<T> {
      if (memo.has(id)) return memo.get(id) as T;
      const value = JSON.parse(JSON.stringify((await fn()) ?? null)) as T;
      memo.set(id, value);
      return value;
    },
    async sleep(id: string, ms: number): Promise<void> {
      onSleep(id, ms);
    },
  };
}

const JOB_ID = 'job-1';
const ACCOUNT_ID = 'acc-1';

function seed(): void {
  db.rateAllowed = true;
  db.tables = {
    instagram_accounts: [{
      id: ACCOUNT_ID, instagram_user_id: 'ig-1', username: 'creator', is_active: true, paused_until: null,
      access_token_encrypted: encrypt('token', KEY),
    }],
    automations: [{
      id: 'auto-1', instagram_account_id: ACCOUNT_ID, type: 'dm_reply', is_active: true,
      comment_reply_options: [], dm_opening_message_enabled: true, dm_opening_message: 'Hello',
      dm_opening_message_button_title: null, dm_opening_message_button_link: null, ask_to_follow_enabled: false,
      dm_responses: [{ id: 'r1', type: 'text', content: 'R1' }, { id: 'r2', type: 'text', content: 'R2' }],
    }],
    job_queue: [{
      id: JOB_ID, job_type: 'auto_dm', status: 'pending', run_after: nowIso(-1000), attempts: 0, max_attempts: 3,
      lease_owner: null, lease_version: 0, lease_expires_at: null, last_error: null,
      payload: {
        automationId: 'auto-1', instagramAccountId: ACCOUNT_ID, igAccountIgsid: 'ig-1', triggerType: 'dm',
        triggerUserId: 'fan-1', triggerUsername: null, triggerEventId: 'm-1', triggerTimestamp: Date.now(),
        postId: null, commentText: null, messageText: 'link',
      },
    }],
    outbound_actions: [],
    dm_sent_log: [],
    dm_jobs: [],
    dm_logs: [],
    dm_rate_events: [],
    automation_sessions: [],
  };
}

const job = (): Row => db.tables['job_queue']![0]!;
const actionStates = (): unknown[] => db.tables['outbound_actions']!.map((a) => a['state']);
const sendCount = (text: string): number => sends.filter((s) => s === text).length;

beforeEach(() => {
  seed();
  behaviours = {};
  sends = [];
  fakeFetch.mockClear();
});

describe('executeJob', () => {
  it('sends a three-action flow in order, once each', async () => {
    const outcome = await executeJob(makeStep(), JOB_ID, 'run-1');
    expect(outcome.status).toBe('done');
    expect(sends).toEqual(['Hello', 'R1', 'R2']);
    expect(actionStates()).toEqual(['accepted', 'accepted', 'accepted']);
    expect(job()['status']).toBe('done');
    expect(db.tables['dm_sent_log']).toHaveLength(1);
  });

  it('resumes after an explicit rejection without repeating the accepted action', async () => {
    behaviours = { R1: ['retryable'] };
    const crash = new Error('worker crashed while sleeping');
    await expect(executeJob(makeStep((id) => { if (id.startsWith('wait')) throw crash; }), JOB_ID, 'run-1')).rejects.toBe(crash);
    expect(actionStates()).toEqual(['accepted', 'pending', 'pending']);
    expect(sends).toEqual(['Hello', 'R1']);

    // Recovery hands the job to a fresh run once the lease and retry time pass.
    job()['lease_expires_at'] = nowIso(-1000);
    job()['run_after'] = nowIso(-1000);
    db.tables['outbound_actions']![1]!['next_attempt_at'] = nowIso(-1000);

    const outcome = await executeJob(makeStep(), JOB_ID, 'run-2');
    expect(outcome.status).toBe('done');
    expect(sendCount('Hello')).toBe(1);
    expect(sends).toEqual(['Hello', 'R1', 'R1', 'R2']);
    expect(actionStates()).toEqual(['accepted', 'accepted', 'accepted']);
  });

  it('marks a timed-out send uncertain and halts the remaining actions', async () => {
    behaviours = { R1: ['timeout'] };
    const outcome = await executeJob(makeStep(), JOB_ID, 'run-1');
    expect(outcome.status).toBe('uncertain');
    expect(actionStates()).toEqual(['accepted', 'uncertain', 'pending']);
    expect(sendCount('R2')).toBe(0);
    expect(job()['status']).toBe('uncertain');

    await executeJob(makeStep(), JOB_ID, 'run-2');
    expect(sends).toEqual(['Hello', 'R1']);
  });

  it('dispatches once when duplicate job.ready events run concurrently', async () => {
    const results = await Promise.all([
      executeJob(makeStep(), JOB_ID, 'run-1'),
      executeJob(makeStep(), JOB_ID, 'run-2'),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['done', 'not_claimed']);
    expect(sends).toEqual(['Hello', 'R1', 'R2']);

    await executeJob(makeStep(), JOB_ID, 'run-3');
    expect(sends).toHaveLength(3);
  });

  it('never retries a terminal Meta error', async () => {
    behaviours = { Hello: ['terminal'] };
    const outcome = await executeJob(makeStep(), JOB_ID, 'run-1');
    expect(outcome.status).toBe('failed');
    expect(sends).toEqual(['Hello']);
    expect(actionStates()).toEqual(['failed', 'pending', 'pending']);
    expect(db.tables['outbound_actions']![0]!['attempts']).toBe(1);

    await executeJob(makeStep(), JOB_ID, 'run-2');
    expect(sends).toEqual(['Hello']);
  });

  it('does not send while the account is paused', async () => {
    db.tables['instagram_accounts']![0]!['paused_until'] = nowIso(3600_000);
    const stop = new Error('stop');
    await expect(
      executeJob(makeStep((id) => { if (id.startsWith('wait')) throw stop; }), JOB_ID, 'run-1')
    ).rejects.toBe(stop);
    expect(sends).toHaveLength(0);
    expect(job()['status']).toBe('suspended');
  });

  it('skips without sending when the account is deactivated before dispatch', async () => {
    db.tables['instagram_accounts']![0]!['is_active'] = false;
    const outcome = await executeJob(makeStep(), JOB_ID, 'run-1');
    expect(outcome.status).toBe('skipped');
    expect(sends).toHaveLength(0);
  });

  it('replays memoized steps without repeating sends', async () => {
    const step = makeStep();
    await executeJob(step, JOB_ID, 'run-1');
    job()['status'] = 'processing';
    await executeJob(step, JOB_ID, 'run-1');
    expect(sends).toEqual(['Hello', 'R1', 'R2']);
  });
});
