import { spawn } from 'node:child_process';
import { runVercelBuild } from '@/lib/vercel-build';

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: 'inherit',
    });

    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      const outcome = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`;
      reject(new Error(`${command} ${args.join(' ')} failed with ${outcome}`));
    });
  });
}

async function main(): Promise<void> {
  await runVercelBuild(run);
}

main().catch((error) => {
  console.error('Vercel build failed:', error);
  process.exit(1);
});
