/**
 * Inngest functions - the only code paths that execute Instagram sends.
 *
 * processWebhookEvent: stored inbox row → jobs (idempotent) → job.ready events.
 *                      Button taps usually skip this; the receiver fast-tracks them.
 * runJob:              one job → claim, prepare, per-action sends, finalize.
 */

import { inngest, jobReady, jobReadyEvent, webhookReceived } from '@/lib/inngest/client';
import { markInboxFailed, processStoredInboxEvent } from '@/lib/automation/inbox';
import { markPublished, unpublishedJobs } from '@/lib/automation/queue';
import { executeJob, recordJobFailure, type WorkflowStep } from '@/lib/automation/processJob';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const processWebhookEvent = inngest.createFunction(
  {
    id: 'process-webhook-event',
    triggers: [webhookReceived],
    concurrency: { limit: 1, key: 'event.data.instagramAccountId' },
    retries: 5,
    onFailure: async ({ event, error }) => {
      await markInboxFailed(event.data.event.data.inboxId, errorMessage(error));
    },
  },
  async ({ event, step }) => {
    const jobs = await step.run('process-event', () => processStoredInboxEvent(event.data.inboxId));
    const refs = await step.run('find-unpublished-jobs', () => unpublishedJobs([...jobs.created, ...jobs.existing]));
    if (refs.length > 0) {
      await step.sendEvent('publish-jobs', refs.map((r) => jobReadyEvent(r.jobId, r.instagramAccountId, r.generation, r.jobType)));
      await step.run('mark-jobs-published', async () => {
        await Promise.all(refs.map((r) => markPublished('job_queue', r.jobId, r.generation)));
      });
    }
    return { created: jobs.created.length, existing: jobs.existing.length, published: refs.length };
  }
);

export const runJob = inngest.createFunction(
  {
    id: 'run-job',
    triggers: [jobReady],
    // One active run per account and job type, so button follow-ups never queue behind initial DMs.
    // The job lease and action guards cover what this cannot.
    concurrency: { limit: 1, key: 'event.data.instagramAccountId + "-" + event.data.jobType' },
    retries: 3,
    onFailure: async ({ event, error }) => {
      await recordJobFailure(event.data.event.data.jobId, errorMessage(error));
    },
  },
  async ({ event, step, runId }) => {
    const workflowStep: WorkflowStep = {
      run: <T>(id: string, fn: () => Promise<T>) => step.run(id, fn) as Promise<T>,
      sleep: (id: string, ms: number) => step.sleep(id, ms),
    };
    return executeJob(workflowStep, event.data.jobId, runId);
  }
);

export const functions = [processWebhookEvent, runJob];
