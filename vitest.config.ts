import path from 'node:path';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig(({ mode }) => {
  const integration = mode === 'integration';
  return {
    resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
    test: {
      environment: 'node',
      include: integration ? ['tests/**/*.integration.test.ts'] : ['tests/**/*.test.ts'],
      exclude: integration ? [] : ['tests/**/*.integration.test.ts'],
      // Integration tests read TEST_SUPABASE_* (and the production URL to refuse it) from .env.
      env: integration ? loadEnv('', process.cwd(), '') : {},
    },
  };
});
