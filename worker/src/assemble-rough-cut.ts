/**
 * The assemble job lives in lib/rough-cut/assemble-job.ts so it is type-checked
 * and unit tested with the app. The worker image copies that directory next to
 * src, which is what makes this relative import resolve there.
 */
export { assembleRoughCut, fillTranscriptSpeakers } from '../lib/rough-cut/assemble-job';
export type { AssembleDeps, RunFn } from '../lib/rough-cut/assemble-job';
