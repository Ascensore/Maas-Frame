import { claimPendingAgentRuns, executeAgentRun } from '@/lib/agents';
import { logError } from '@/lib/logger';

const POLL_MS = 1000;
const ERROR_BACKOFF_MS = 2000;
const BATCH = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

let stopping = false;

process.on('SIGINT', () => {
  stopping = true;
});
process.on('SIGTERM', () => {
  stopping = true;
});

async function tick(): Promise<void> {
  const ids = await claimPendingAgentRuns(BATCH);
  if (ids.length === 0) {
    await sleep(POLL_MS);
    return;
  }

  for (const id of ids) {
    if (stopping) return;
    try {
      await executeAgentRun(id);
      console.log(`agent run ${id} succeeded`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logError(`agent run ${id} failed: ${message}`, error);
    }
  }
}

async function main(): Promise<void> {
  console.log('agent worker started');
  while (!stopping) {
    try {
      await tick();
    } catch (error) {
      logError('agent worker tick failed', error);
      await sleep(ERROR_BACKOFF_MS);
    }
  }
  console.log('agent worker stopped');
}

main().catch((error) => {
  logError('agent worker crashed', error);
  process.exit(1);
});
