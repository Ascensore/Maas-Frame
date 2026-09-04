import { WAITING_FOR_TRANSCRIPT_WARNING } from './transcript-source';

export const ROUGH_CUT_WORKER_WAIT_MS = 30_000;

export function isWaitingForMediaWorker(
  status: string,
  createdAtIso: string,
  nowMs: number
): boolean {
  if (status !== 'PENDING') return false;
  const created = Date.parse(createdAtIso);
  if (!Number.isFinite(created)) return false;
  return nowMs - created >= ROUGH_CUT_WORKER_WAIT_MS;
}

/**
 * A RUNNING cut that the worker parked until a transcript is ready reports
 * it through a warning, since the row has no dedicated status for it.
 */
export function isWaitingForTranscript(
  status: string,
  warnings: ReadonlyArray<{ code: string }> | null | undefined
): boolean {
  if (status !== 'RUNNING') return false;
  return (warnings ?? []).some((warning) => warning.code === WAITING_FOR_TRANSCRIPT_WARNING);
}
