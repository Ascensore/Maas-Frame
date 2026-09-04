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
