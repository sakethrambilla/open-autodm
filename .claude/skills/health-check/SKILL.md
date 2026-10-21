---
name: health-check
description: Check the health of open-autodm's services — Supabase, pg_cron, Inngest, the Vercel deployment and Cloudflare Workers. Use when asked "is everything up", "check health", "why aren't DMs sending", or before/after a deploy.
---

# Health check

Run the read-only checker from the repo root:

```bash
direnv exec . npm run health -- --json                          # against HEALTH_APP_URL / NEXT_PUBLIC_APP_URL from .env
direnv exec . npm run health -- --json --url https://prod-url   # against another deployment
```

`.env` usually points at `http://localhost:3000`; if the user means production, ask for the URL or use the Vercel/Cloudflare URL rather than reporting localhost as down. Run it through `direnv exec .`: the parent `.envrc` sets `XDG_DATA_HOME`, which is where the Vercel CLI keeps the personal account's login. Exit code 1 means at least one check failed.

## What each check means

| Service | Check | Failure usually means |
|---|---|---|
| supabase | `/auth/v1/health` + a REST count on `app_settings` with the service role key | Wrong URL/key, or the project is paused |
| cron | `webhook_inbox` / `job_queue` rows due >15 min ago | pg_cron isn't firing, or it's calling a dead/wrong URL |
| cron | `cron.job` + latest `cron.job_run_details` (needs `SUPABASE_DB_URL`) | Job missing/inactive (re-run Setup Wizard SQL) or failing |
| cron | unauthenticated POST to `/api/cron/process-jobs` expects 401 | Route not deployed / app down |
| inngest | GET `/api/inngest` introspection | 0 functions, or missing signing/event key in cloud mode |
| vercel | `vercel list <project> --prod` latest state is READY | Build failed, or wrong `VERCEL_PROJECT` / `VERCEL_SCOPE` |
| cloudflare | `wrangler deployments list --name open-autodm` | Never deployed, or wrangler not authenticated |

## Optional env vars

- `SUPABASE_DB_URL` — Postgres connection string (Supabase → Connect → session pooler) to read pg_cron history via `psql`.
- `VERCEL_PROJECT` (name or id, falls back to `VERCEL_PROJECT_ID`) `VERCEL_SCOPE` (team slug) and `VERCEL_TOKEN` if the CLI is logged into a different account.
- `VERCEL_APP_URL`, `CLOUDFLARE_APP_URL` — also ping each host directly.
- `CLOUDFLARE_WORKER_NAME` (default `open-autodm`), `CLOUDFLARE_API_TOKEN` for non-interactive wrangler.

## Reporting

Summarise as one line per service (ok / warn / fail / skipped) and, for each failure, the likely cause and fix from the table above. Treat `skip` as "not checked", never as healthy. Don't trigger cron or Inngest runs to "test" them — the checks are read-only on purpose.
