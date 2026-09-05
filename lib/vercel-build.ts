export type VercelBuildStep = readonly [command: string, ...args: string[]];
export type VercelBuildRunner = (command: string, args: string[]) => Promise<void>;

/**
 * Production deploys must apply committed Prisma migrations before Vercel can
 * publish code generated from the matching schema. Preview builds have no
 * production DATABASE_URL and must never mutate that database.
 */
export function vercelBuildSteps(environment: string | undefined): VercelBuildStep[] {
  const steps: VercelBuildStep[] = [];

  if (environment === 'production') {
    steps.push(['bun', 'run', 'db:migrate']);
  }

  steps.push(['bun', 'run', 'build']);
  return steps;
}

export async function runVercelBuild(
  runner: VercelBuildRunner,
  environment = process.env.VERCEL_ENV
): Promise<void> {
  for (const [command, ...args] of vercelBuildSteps(environment)) {
    await runner(command, args);
  }
}
