import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/unit/**/*.test.ts'],
          server: {
            deps: {
              // lib/auth.ts pulls in next-auth, whose lib/env.js imports
              // 'next/server'. Node's ESM resolver cannot resolve that extensionless
              // specifier, so the module has to go through Vite's resolver instead
              // of being externalised. Bun resolves it either way; this keeps the
              // suite runnable under plain Node too, which is how coverage runs.
              inline: [/next-auth/],
            },
          },
        },
      },
      {
        extends: true,
        test: {
          name: 'api',
          environment: 'node',
          include: ['tests/api/**/*.test.ts'],
          setupFiles: ['tests/setup/api.ts'],
          globalSetup: ['tests/setup/db-global.ts'],
          // One shared test database; parallel files would fight over TRUNCATE.
          fileParallelism: false,
          testTimeout: 20_000,
        },
      },
      {
        extends: true,
        plugins: [tsconfigPaths(), react()],
        test: {
          name: 'component',
          environment: 'jsdom',
          include: ['tests/component/**/*.test.{ts,tsx}'],
          setupFiles: ['tests/setup/component.ts'],
        },
      },
    ],
  },
});
