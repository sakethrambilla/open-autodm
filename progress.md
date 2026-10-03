# open-autoDM progress

Last updated: 3 October 2026.

## Completed

- Reviewed `docs/implementation.md`; it remains a proposal and no application implementation has started.
- Confirmed the original Vercel CLI session was authenticated as `saketh-3690` but targeted the `nikhil-samas-projects-c7296f58` team, which does not contain `open-autodm`.
- Located the personal dashboards in Arc:
  - Vercel: `sakethrambilla's projects`.
  - Supabase: `sakethrambilla's Org`.
  - Inngest: a new `open-autodm` organization.
- Created a dedicated Supabase project named `open-autodm` in Southeast Asia (Singapore), project ref `edscfelimnnhjeobbwwp`.
- Created a dedicated Vercel project named `open-autodm` in `sakethrambilla's projects`, project ID `prj_YPOV1DEjOk4va85LjLvlkjt8FwMr`.
- Configured the Vercel project for Next.js and Node.js 24.
- Created an `open-autodm` Inngest organization and retained its default production event and signing keys.
- Created a local `.env` file with owner-only permissions (`600`) and confirmed it is ignored by Git.
- Saved these local configuration values without committing them:
  - `NEXT_PUBLIC_SUPABASE_URL`
  - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
  - `SUPABASE_SERVICE_ROLE_KEY`
  - `SUPABASE_PASSWORD`
  - `TOKEN_ENCRYPTION_KEY`
  - `CRON_SECRET`
  - `INNGEST_EVENT_KEY`
  - `INNGEST_SIGNING_KEY`
  - `NEXT_PUBLIC_APP_URL` set to `http://localhost:3000`
  - `VERCEL_PROJECT_ID`
- Verified the Supabase anon and service-role keys match the created project and that its Auth API returns HTTP 200.

## Not started

- No Supabase migrations have been applied.
- No application code has been changed for the implementation plan.
- No Inngest SDK or CLI has been installed, and no `/api/inngest` endpoint exists to sync.
- No Vercel environment variables have been configured and no deployment has been made.
- No Meta app, Instagram account, webhooks, or production cron schedules have been configured.
- No tests have been added or run for the planned durable-processing work.

## Existing repository state

- `docs/implementation.md` is an untracked local plan.
- The repository retains its current legacy Vercel cron in `vercel.json`; the plan calls for removing it only in Task 3 after Supabase cron recovery is implemented.

## Execution log

**Status:** in progress — no commits (not requested), no remote migrations or deploys.

- 2026-10-03 Task 1 — done (uncommitted). `npm run test` 14/14, typecheck green, `test:integration` exit 0 but skipped (no test Supabase project).
  - Deviations: receiver stores only, nothing processes until Task 2; comment jobs keyed per account/comment (oldest automation wins); session lookup errors now throw; postback fallback key unverified against real payloads; unsupported events dropped at receipt; migration also revokes anon/authenticated EXECUTE on legacy RPCs.
- 2026-10-03 Task 2 — done (uncommitted). processing tests 8/8, `npm run test` 22/22, typecheck and build green; `/api/inngest` synced to a local `inngest-cli dev` (4 functions incl. failure handlers), no events run against the real Supabase project.
  - Deviations: `.npmrc` `legacy-peer-deps=true` (inngest optional peer @sveltejs/kit conflicts with vitest's vite) plus explicit `react-is`; rate budget now counted per DM action; prepare-time inactive account skips instead of retrying; suspended jobs are not republished by recovery yet (Task 3).
- 2026-10-03 Task 3 — done (uncommitted). `npm run test` 34/34 (new tests/recovery.test.ts 12), `test:integration` exit 0 but skipped, typecheck and build green. Live setup-twice / `cron.job` checks not run (no test Supabase project).
  - Deviations: new migration `20261003000002_cron_recovery_maintenance.sql` replaces the claim/complete publication RPCs and adds `maintenance_locks` (lease row, not advisory lock) and `cleanup_batch`; publication capped at 20 generations with 30s→1h backoff; stranded suspended jobs (wake time 15+ min past) are republished at most every 15 min; failed inbox rows are terminal; vercel.json reduced to `{}`; setup page copy updated for the three schedules; `cleanup_old_rows` left in place but unused.
- 2026-10-03 Task 4 step 1 — done (uncommitted). Debug route returns owner-scoped failed/uncertain/delayed inbox and job rows plus recent outbound actions (no payloads/snapshots/recipients, errors truncated to 300 chars); panel labels acceptance "accepted by Instagram". New tests/debug.test.ts (3). SELF_HOSTING/TESTING cron passages updated. Steps 2–6 (invite-only login checks, Meta audience test, prod migration + paused deploy, real sends, pause/revocation/rollback) await the owner.
