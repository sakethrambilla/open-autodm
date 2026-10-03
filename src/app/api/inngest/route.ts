/**
 * Inngest serve endpoint. Authenticated by Inngest request signing
 * (INNGEST_SIGNING_KEY), not by dashboard sessions or CRON_SECRET. Outside
 * INNGEST_DEV the SDK runs in cloud mode and rejects unsigned requests.
 */

import { serve } from 'inngest/next';
import { inngest } from '@/lib/inngest/client';
import { functions } from '@/lib/inngest/functions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export const { GET, POST, PUT } = serve({ client: inngest, functions });
