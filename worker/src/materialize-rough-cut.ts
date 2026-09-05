/**
 * The materialize job lives in lib/rough-cut/materialize-job.ts so it is
 * type-checked and unit tested with the app. The worker image copies that
 * directory next to src, which is what makes this relative import resolve there.
 */
export { materializeRoughCut } from '../lib/rough-cut/materialize-job';
export type { MaterializeDeps } from '../lib/rough-cut/materialize-job';
