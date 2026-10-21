// Read-only health check for Supabase, pg_cron, Inngest, Vercel and Cloudflare Workers.
// Usage: npm run health -- [--url https://your-app] [--json]
// Exit code 1 if any check fails; warnings and skips don't fail the run.

import { execFile } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { promisify } from 'node:util';

const run = promisify(execFile);
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

const env = process.env;
const APP_URL = (flag('--url') ?? env.HEALTH_APP_URL ?? env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/$/, '');
const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
// pg_cron re-publishes due work every 5 minutes, so anything due longer than this means cron isn't firing.
const STUCK_AFTER_MINUTES = 15;
const TIMEOUT_MS = 15_000;

const results = [];
const report = (service, status, detail) => results.push({ service, status, detail });

async function http(url, init = {}) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

async function cli(cmd, cmdArgs) {
  const { stdout } = await run(cmd, cmdArgs, { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 });
  return stdout;
}

async function supabaseCount(table, query) {
  const res = await http(`${SUPABASE_URL}/rest/v1/${table}?select=id&${query}`, {
    method: 'HEAD',
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, Prefer: 'count=exact' },
  });
  if (!res.ok) throw new Error(`${table}: HTTP ${res.status}`);
  return Number(res.headers.get('content-range')?.split('/')[1] ?? 0);
}

async function checkSupabase() {
  if (!SUPABASE_URL || !SERVICE_KEY) return report('supabase', 'skip', 'NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');
  try {
    const auth = await http(`${SUPABASE_URL}/auth/v1/health`, { headers: { apikey: SERVICE_KEY } });
    if (!auth.ok) return report('supabase', 'fail', `auth health HTTP ${auth.status}`);
    const settings = await supabaseCount('app_settings', 'limit=1');
    report('supabase', 'ok', `auth + REST reachable, app_settings rows: ${settings}`);
  } catch (err) {
    report('supabase', 'fail', err.message);
  }
}

async function checkCron() {
  if (SUPABASE_URL && SERVICE_KEY) {
    try {
      const cutoff = new Date(Date.now() - STUCK_AFTER_MINUTES * 60_000).toISOString();
      const [inbox, jobs, exhausted] = await Promise.all([
        supabaseCount('webhook_inbox', `state=eq.received&publish_generation=lt.20&next_publish_at=lt.${cutoff}`),
        supabaseCount('job_queue', `status=eq.pending&publish_generation=lt.20&next_publish_at=lt.${cutoff}`),
        supabaseCount('webhook_inbox', 'state=eq.received&publish_generation=gte.20'),
      ]);
      const stuck = inbox + jobs;
      if (stuck > 0) report('cron', 'fail', `${stuck} items due >${STUCK_AFTER_MINUTES}m ago (inbox ${inbox}, jobs ${jobs}) - pg_cron likely not firing`);
      else report('cron', 'ok', `no work overdue >${STUCK_AFTER_MINUTES}m`);
      if (exhausted > 0) report('cron', 'warn', `${exhausted} inbox rows hit the 20-attempt publish cap`);
    } catch (err) {
      report('cron', 'fail', `queue check: ${err.message}`);
    }
  }

  if (env.SUPABASE_DB_URL) {
    try {
      const sql = `select j.jobname, j.active, d.status, d.start_time, d.return_message
        from cron.job j
        left join lateral (select * from cron.job_run_details r where r.jobid = j.jobid order by start_time desc limit 1) d on true
        where j.jobname like 'open-autodm-%'`;
      const out = await cli('psql', [env.SUPABASE_DB_URL, '-At', '-F', '\t', '-c', sql]);
      const rows = out.trim().split('\n').filter(Boolean).map((l) => l.split('\t'));
      if (rows.length === 0) report('cron', 'fail', 'no open-autodm-* jobs in cron.job - run the Setup Wizard SQL');
      for (const [name, active, status, start, message] of rows) {
        const state = active !== 't' ? 'fail' : status === 'failed' ? 'fail' : status === 'succeeded' ? 'ok' : 'warn';
        report('cron', state, `${name}: active=${active} last=${status || 'never'} ${start || ''} ${status === 'failed' ? message : ''}`.trim());
      }
    } catch (err) {
      report('cron', 'fail', `psql: ${err.message.split('\n')[0]}`);
    }
  } else {
    report('cron', 'skip', 'SUPABASE_DB_URL not set - pg_cron job history not checked');
  }

  if (!APP_URL) return;
  try {
    // Unauthenticated on purpose: a 401 proves the route is deployed without triggering a run.
    const res = await http(`${APP_URL}/api/cron/process-jobs`, { method: 'POST' });
    report('cron', res.status === 401 ? 'ok' : 'fail', `${APP_URL}/api/cron/process-jobs -> HTTP ${res.status} (expect 401)`);
  } catch (err) {
    report('cron', 'fail', `cron route unreachable: ${err.message}`);
  }
}

async function checkInngest() {
  if (!APP_URL) return report('inngest', 'skip', 'no app URL (--url or NEXT_PUBLIC_APP_URL)');
  try {
    const res = await http(`${APP_URL}/api/inngest`, { headers: inngestSignatureHeader() });
    if (res.status === 401) return report('inngest', 'fail', '/api/inngest rejected the signature - deployed INNGEST_SIGNING_KEY differs from local .env');
    if (!res.ok) return report('inngest', 'fail', `/api/inngest HTTP ${res.status}`);
    const body = await res.json();
    const problems = [];
    if (!body.function_count) problems.push('0 functions registered');
    if (body.mode === 'cloud' && !body.has_signing_key) problems.push('no signing key');
    if (body.mode === 'cloud' && !body.has_event_key) problems.push('no event key');
    const detail = `mode=${body.mode} functions=${body.function_count} signing_key=${body.has_signing_key} event_key=${body.has_event_key}`;
    report('inngest', problems.length ? 'fail' : 'ok', problems.length ? `${problems.join(', ')} (${detail})` : detail);
  } catch (err) {
    report('inngest', 'fail', `/api/inngest unreachable: ${err.message}`);
  }
}

// Mirrors the SDK's request signing (inngest/helpers/net.js): HMAC-SHA256 over body + timestamp, GET body is empty.
function inngestSignatureHeader() {
  if (!env.INNGEST_SIGNING_KEY) return {};
  const ts = Math.round(Date.now() / 1000).toString();
  const key = env.INNGEST_SIGNING_KEY.replace(/^signkey-[\w]+-/, '');
  return { 'X-Inngest-Signature': `t=${ts}&s=${createHmac('sha256', key).update(ts).digest('hex')}` };
}

async function checkVercel() {
  const project = env.VERCEL_PROJECT ?? env.VERCEL_PROJECT_ID;
  if (!project) return report('vercel', 'skip', 'VERCEL_PROJECT not set');
  const scope = [...(env.VERCEL_SCOPE ? ['--scope', env.VERCEL_SCOPE] : []), ...(env.VERCEL_TOKEN ? ['--token', env.VERCEL_TOKEN] : [])];
  try {
    const out = await cli('vercel', ['list', project, '--prod', '--format', 'json', ...scope]);
    const latest = JSON.parse(out).deployments?.[0];
    if (!latest) return report('vercel', 'fail', 'no production deployments');
    const state = latest.state ?? latest.readyState;
    report('vercel', state === 'READY' ? 'ok' : 'fail', `latest prod ${latest.url} state=${state} at ${new Date(latest.createdAt).toISOString()}`);
  } catch (err) {
    let msg = `${err.stderr ?? ''}`.split('\n').find((l) => /error/i.test(l)) ?? err.message.split('\n')[0];
    try { msg = JSON.parse(err.stdout).message ?? msg; } catch {}
    report('vercel', 'fail', `vercel CLI: ${msg.trim()}`);
  }
  if (env.VERCEL_APP_URL) await pingSite('vercel', env.VERCEL_APP_URL);
}

async function checkCloudflare() {
  const worker = env.CLOUDFLARE_WORKER_NAME ?? 'open-autodm';
  try {
    const out = await cli('npx', ['wrangler', 'deployments', 'list', '--name', worker, '--json']);
    const deployments = JSON.parse(out);
    const latest = deployments.at(-1);
    if (!latest) report('cloudflare', 'fail', `no deployments for worker ${worker}`);
    else report('cloudflare', 'ok', `worker ${worker} latest deployment ${latest.id} at ${latest.created_on}`);
  } catch (err) {
    const msg = `${err.stderr ?? ''}${err.message}`.replace(/\x1b\[[0-9;]*m/g, '');
    if (/code: 10007/.test(msg)) report('cloudflare', 'skip', `worker ${worker} not deployed on this Cloudflare account`);
    else if (/not logged in|CLOUDFLARE_API_TOKEN/i.test(msg)) report('cloudflare', 'skip', 'wrangler not authenticated - run `npx wrangler login` or set CLOUDFLARE_API_TOKEN');
    else report('cloudflare', 'fail', `wrangler: ${(msg.match(/ERROR.*/) ?? [msg])[0].slice(0, 200)}`);
  }
  if (env.CLOUDFLARE_APP_URL) await pingSite('cloudflare', env.CLOUDFLARE_APP_URL);
}

async function pingSite(service, url) {
  try {
    const res = await http(url, { redirect: 'manual' });
    report(service, res.status < 500 ? 'ok' : 'fail', `${url} -> HTTP ${res.status}`);
  } catch (err) {
    report(service, 'fail', `${url} unreachable: ${err.message}`);
  }
}

await Promise.all([checkSupabase(), checkCron(), checkInngest(), checkVercel(), checkCloudflare()]);

const order = ['supabase', 'cron', 'inngest', 'vercel', 'cloudflare'];
results.sort((a, b) => order.indexOf(a.service) - order.indexOf(b.service));

if (args.includes('--json')) {
  console.log(JSON.stringify({ appUrl: APP_URL, results }, null, 2));
} else {
  const icon = { ok: '✓', warn: '!', fail: '✗', skip: '-' };
  console.log(`App URL: ${APP_URL || '(none)'}\n`);
  for (const r of results) console.log(`${icon[r.status]} ${r.service.padEnd(11)} ${r.detail}`);
}

process.exit(results.some((r) => r.status === 'fail') ? 1 : 0);
