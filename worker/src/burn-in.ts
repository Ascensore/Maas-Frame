/**
 * The burn-in job lives in lib/rough-cut/burn-in-job.ts so it is type-checked
 * and unit tested with the app. The worker image copies that directory next to
 * src, which is what makes this relative import resolve there.
 */
export { burnInSubtitles, parseBurnInPayload } from '../lib/rough-cut/burn-in-job';
export type { BurnInDeps, BurnInPayload } from '../lib/rough-cut/burn-in-job';
