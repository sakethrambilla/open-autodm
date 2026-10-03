import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;
const SECRET = 'cron-secret-for-tests-0123456789';
const MIN = 60_000;
const iso = (offsetMs = 0): string => new Date(Date.now() + offsetMs).toISOString();
const due = (r: Row, col: string): boolean => Date.parse(r[col] as string) <= Date.now();

// Mirrors the claim/complete/lock RPC semantics of the SQL migrations.
class FakeDb {
  inbox: Row[] = [];
  jobs: Row[] = [];
  locks = new Map<string, { owner: string; until: number }>();
  calls: string[] = [];

  async rpc(fn: string, args: Record<string, unknown>) {
    this.calls.push(fn);
    const claimable = (r: Row) =>
      ['pending', 'failed'].includes(r['publish_state'] as string) ||
      (r['publish_state'] === 'publishing' && Date.parse(r['publish_lease_until'] as string) < Date.now());
    const claim = (rows: Row[], limit: number) =>
      rows.slice(0, limit).map((r) => {
        Object.assign(r, { publish_state: 'publishing', publish_generation: (r['publish_generation'] as number) + 1, publish_lease_until: iso(2 * MIN) });
        return { id: r['id'], instagram_account_id: r['account'], publish_generation: r['publish_generation'] };
      });
    switch (fn) {
      case 'recover_stale_leases':
        return { data: [{ requeued: 0, uncertain: 0 }], error: null };
      case 'claim_inbox_publication': {
        const rows = this.inbox.filter((r) => r['state'] === 'received' && due(r, 'next_publish_at') && claimable(r) && (r['publish_generation'] as number) < 20);
        return { data: claim(rows, args['p_limit'] as number), error: null };
      }
      case 'claim_job_publication': {
        const rows = this.jobs.filter((r) => due(r, 'next_publish_at') && (r['publish_generation'] as number) < 20 && (
          (r['status'] === 'pending' && claimable(r)) ||
          (r['status'] === 'suspended' && Date.parse(r['run_after'] as string) < Date.now() - 15 * MIN && r['publish_state'] !== 'publishing')
        ));
        rows.filter((r) => r['status'] === 'suspended').forEach((r) => { r['next_publish_at'] = iso(15 * MIN); });
        return { data: claim(rows, args['p_limit'] as number), error: null };
      }
      case 'complete_publication': {
        const rows = args['p_table'] === 'webhook_inbox' ? this.inbox : this.jobs;
        const r = rows.find((x) => x['id'] === args['p_id'] && x['publish_generation'] === args['p_generation'] && x['publish_state'] !== 'published');
        if (!r) return { data: false, error: null };
        if (args['p_published']) Object.assign(r, { publish_state: 'published', publish_lease_until: null });
        else Object.assign(r, { publish_state: 'failed', publish_lease_until: null, next_publish_at: iso(5 * MIN), last_error: args['p_error'] });
        return { data: true, error: null };
      }
      case 'try_maintenance_lock': {
        const held = this.locks.get(args['p_name'] as string);
        if (held && held.until > Date.now()) return { data: false, error: null };
        this.locks.set(args['p_name'] as string, { owner: args['p_owner'] as string, until: Date.now() + (args['p_seconds'] as number) * 1000 });
        return { data: true, error: null };
      }
      case 'release_maintenance_lock': {
        if (this.locks.get(args['p_name'] as string)?.owner === args['p_owner']) this.locks.delete(args['p_name'] as string);
        return { data: null, error: null };
      }
      case 'cleanup_batch':
        return { data: { jobs_deleted: 0 }, error: null };
      default:
        throw new Error(`unexpected rpc ${fn}`);
    }
  }

  // Token refresh reads instagram_accounts; no account is due in these tests.
  from() {
    const q = { select: () => q, eq: () => q, not: () => q, gt: () => q, lt: () => q, then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok) };
    return q;
  }
}

let db = new FakeDb();
const send = vi.fn(async (_events: unknown[]) => ({ ids: [] }));

vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => db }));
vi.mock('@/lib/debugLog', () => ({ debugLog: () => undefined }));
vi.mock('@/lib/env', () => ({ getEnv: () => ({ CRON_SECRET: SECRET, TOKEN_ENCRYPTION_KEY: 'a'.repeat(64) }) }));
vi.mock('next/headers', () => ({ cookies: async () => ({ getAll: () => [] }) }));
vi.mock('@/lib/inngest/client', () => ({
  inngest: { send: (events: unknown[]) => send(events) },
  webhookReceivedEvent: (id: string, accountId: string, gen: number) => ({ name: 'instagram/webhook.received', id: `inbox-${id}-${gen}`, data: { accountId } }),
  jobReadyEvent: (id: string, accountId: string, gen: number) => ({ name: 'instagram/job.ready', id: `job-${id}-${gen}`, data: { accountId } }),
}));

const { POST: processJobs } = await import('@/app/api/cron/process-jobs/route');
const { POST: maintenance } = await import('@/app/api/cron/maintenance/route');
const { refreshExpiringTokens } = await import('@/lib/automation/maintenance');

function cronRequest(path: string, body?: unknown, auth = `Bearer ${SECRET}`): Request {
  return new Request(`https://app.test${path}`, {
    method: 'POST',
    headers: auth ? { authorization: auth, 'content-type': 'application/json' } : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function inboxRow(id: string, extra: Row = {}): Row {
  return { id, account: 'acct-1', state: 'received', publish_state: 'pending', publish_generation: 0, next_publish_at: iso(-MIN), ...extra };
}

function jobRow(id: string, extra: Row = {}): Row {
  return { id, account: 'acct-1', status: 'pending', publish_state: 'pending', publish_generation: 0, next_publish_at: iso(-MIN), run_after: iso(-MIN), ...extra };
}

beforeEach(() => {
  db = new FakeDb();
  send.mockReset();
  send.mockResolvedValue({ ids: [] });
});

describe('cron authentication', () => {
  it('rejects missing, wrong and query-string secrets with 401', async () => {
    expect((await processJobs(cronRequest('/api/cron/process-jobs', undefined, ''))).status).toBe(401);
    expect((await processJobs(cronRequest('/api/cron/process-jobs', undefined, 'Bearer nope'))).status).toBe(401);
    expect((await processJobs(cronRequest(`/api/cron/process-jobs?secret=${SECRET}`, undefined, ''))).status).toBe(401);
    expect((await maintenance(cronRequest('/api/cron/maintenance', { mode: 'cleanup' }, ''))).status).toBe(401);
    expect(db.calls).toEqual([]);
  });

  it('validates the maintenance mode', async () => {
    expect((await maintenance(cronRequest('/api/cron/maintenance', { mode: 'drop-everything' }))).status).toBe(400);
    expect((await maintenance(cronRequest('/api/cron/maintenance'))).status).toBe(400);
  });
});

describe('recovery publication', () => {
  it('an empty poll emits zero Inngest events', async () => {
    const res = await processJobs(cronRequest('/api/cron/process-jobs'));
    expect(res.status).toBe(200);
    expect(send).not.toHaveBeenCalled();
    expect(db.calls[0]).toBe('recover_stale_leases');
  });

  it('publishes due inbox and job rows in one batch and records the generation', async () => {
    db.inbox.push(inboxRow('in-1'));
    db.jobs.push(jobRow('job-1'));
    await processJobs(cronRequest('/api/cron/process-jobs'));
    expect(send).toHaveBeenCalledTimes(1);
    expect((send.mock.calls[0]![0] as Array<{ id: string }>).map((e) => e.id)).toEqual(['inbox-in-1-1', 'job-job-1-1']);
    expect(db.inbox[0]).toMatchObject({ publish_state: 'published', publish_generation: 1 });
    expect(db.jobs[0]).toMatchObject({ publish_state: 'published', publish_generation: 1 });
  });

  it('a failed publish marks rows failed with backoff and retries once due', async () => {
    db.inbox.push(inboxRow('in-1'));
    send.mockRejectedValueOnce(new Error('inngest down'));
    const body = (await (await processJobs(cronRequest('/api/cron/process-jobs'))).json()) as { failed: number };
    expect(body.failed).toBe(1);
    expect(db.inbox[0]).toMatchObject({ publish_state: 'failed', last_error: 'inngest down' });

    await processJobs(cronRequest('/api/cron/process-jobs'));
    expect(send).toHaveBeenCalledTimes(1);

    db.inbox[0]!['next_publish_at'] = iso(-1);
    await processJobs(cronRequest('/api/cron/process-jobs'));
    expect(send).toHaveBeenCalledTimes(2);
    expect(db.inbox[0]).toMatchObject({ publish_state: 'published', publish_generation: 2 });
  });

  it('an accepted but unrecorded publish is republished under a new generation once its claim expires', async () => {
    db.jobs.push(jobRow('job-1'));
    // Inngest accepts the send, then recording the result fails.
    db.rpc = ((orig) => async (fn: string, args: Record<string, unknown>) => {
      if (fn === 'complete_publication') throw new Error('lost connection');
      return orig(fn, args);
    })(db.rpc.bind(db));
    await expect(processJobs(cronRequest('/api/cron/process-jobs'))).rejects.toThrow('lost connection');
    expect(db.jobs[0]).toMatchObject({ publish_state: 'publishing', publish_generation: 1 });

    db.rpc = FakeDb.prototype.rpc.bind(db);
    await processJobs(cronRequest('/api/cron/process-jobs'));
    expect(send).toHaveBeenCalledTimes(1);

    db.jobs[0]!['publish_lease_until'] = iso(-1);
    await processJobs(cronRequest('/api/cron/process-jobs'));
    // Generation 2 is a distinct event; claim_job and the action guards absorb the duplicate run.
    expect((send.mock.calls[1]![0] as Array<{ id: string }>)[0]!.id).toBe('job-job-1-2');
    expect(db.jobs[0]).toMatchObject({ publish_state: 'published', publish_generation: 2 });
  });

  it('concurrent cron calls never publish the same row twice', async () => {
    for (let i = 0; i < 5; i += 1) db.inbox.push(inboxRow(`in-${i}`));
    await Promise.all([processJobs(cronRequest('/api/cron/process-jobs')), processJobs(cronRequest('/api/cron/process-jobs'))]);
    const ids = send.mock.calls.flatMap((c) => (c[0] as Array<{ id: string }>).map((e) => e.id));
    expect(ids.sort()).toEqual(['inbox-in-0-1', 'inbox-in-1-1', 'inbox-in-2-1', 'inbox-in-3-1', 'inbox-in-4-1']);
  });

  it('caps a pass at 100 rows', async () => {
    for (let i = 0; i < 120; i += 1) db.jobs.push(jobRow(`job-${i}`));
    await processJobs(cronRequest('/api/cron/process-jobs'));
    expect((send.mock.calls[0]![0] as unknown[]).length).toBe(100);
  });

  it('leaves sleeping runs, terminal inbox rows and exhausted rows alone but recovers stranded suspended jobs', async () => {
    db.jobs.push(jobRow('sleeping', { status: 'suspended', publish_state: 'published', run_after: iso(10 * MIN) }));
    db.jobs.push(jobRow('just-woke', { status: 'suspended', publish_state: 'published', run_after: iso(-2 * MIN) }));
    db.jobs.push(jobRow('stranded', { status: 'suspended', publish_state: 'published', run_after: iso(-20 * MIN) }));
    db.jobs.push(jobRow('exhausted', { publish_state: 'failed', publish_generation: 20 }));
    db.inbox.push(inboxRow('failed-event', { state: 'failed', publish_state: 'published' }));
    db.inbox.push(inboxRow('failed-publish-terminal', { state: 'failed', publish_state: 'failed' }));

    await processJobs(cronRequest('/api/cron/process-jobs'));
    expect((send.mock.calls[0]![0] as Array<{ id: string }>).map((e) => e.id)).toEqual(['job-stranded-1']);

    await processJobs(cronRequest('/api/cron/process-jobs'));
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('maintenance', () => {
  it('token refresh skips when another run holds the lock, then runs once released', async () => {
    db.locks.set('token_refresh', { owner: 'other', until: Date.now() + MIN });
    expect(await refreshExpiringTokens()).toEqual({ status: 'locked' });

    db.locks.get('token_refresh')!.until = Date.now() - 1;
    expect(await refreshExpiringTokens()).toEqual({ status: 'ok', refreshed: 0, failed: 0 });
    expect(db.locks.has('token_refresh')).toBe(false);
  });

  it('concurrent refresh calls run the refresh once', async () => {
    const results = await Promise.all([refreshExpiringTokens(), refreshExpiringTokens()]);
    expect(results.filter((r) => r.status === 'locked')).toHaveLength(1);
  });

  it('cleanup mode runs bounded batches until nothing is left', async () => {
    const res = await maintenance(cronRequest('/api/cron/maintenance', { mode: 'cleanup' }));
    expect(res.status).toBe(200);
    expect(db.calls.filter((c) => c === 'cleanup_batch')).toHaveLength(1);
    expect(send).not.toHaveBeenCalled();
  });
});
