import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runVercelBuild } from '@/lib/vercel-build';

describe('runVercelBuild', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('migrates the production database before building the deployable app', async () => {
    vi.stubEnv('VERCEL_ENV', 'production');
    const runner = vi.fn().mockResolvedValue(undefined);

    await runVercelBuild(runner);

    expect(runner.mock.calls).toEqual([
      ['bun', ['run', 'db:migrate']],
      ['bun', ['run', 'build']],
    ]);
  });

  it('does not migrate a production database from a preview build', async () => {
    vi.stubEnv('VERCEL_ENV', 'preview');
    const runner = vi.fn().mockResolvedValue(undefined);

    await runVercelBuild(runner);

    expect(runner.mock.calls).toEqual([['bun', ['run', 'build']]]);
  });

  it('stops the deployment when the production migration fails', async () => {
    vi.stubEnv('VERCEL_ENV', 'production');
    const migrationError = new Error('migration failed');
    const runner = vi.fn().mockRejectedValueOnce(migrationError);

    await expect(runVercelBuild(runner)).rejects.toBe(migrationError);

    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledWith('bun', ['run', 'db:migrate']);
  });

  it('routes Vercel through the migration-aware build entrypoint', () => {
    const root = process.cwd();
    const vercelConfig = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8')) as {
      buildCommand?: string;
    };
    const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(vercelConfig.buildCommand).toBe('bun run vercel-build');
    expect(packageJson.scripts?.['vercel-build']).toBe('bun run scripts/vercel-build.ts');
  });
});
