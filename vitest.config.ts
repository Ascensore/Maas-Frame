import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    server: {
      deps: {
        // Anything reaching lib/auth.ts pulls in next-auth, whose lib/env.js imports
        // the extensionless specifier 'next/server'. Node's ESM resolver cannot
        // resolve that, so the module has to go through Vite's resolver instead of
        // being externalised. Bun resolves it either way, which is why this is easy
        // to miss: the containers used locally have no node at all, so vitest runs
        // under bun there, while on a GitHub runner the vitest bin's
        // `#!/usr/bin/env node` shebang wins and every suite that touches auth dies
        // with ERR_MODULE_NOT_FOUND. Declared at the root so all three projects
        // inherit it through `extends: true`.
        inline: [/next-auth/],
      },
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/unit/**/*.test.ts'],
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
