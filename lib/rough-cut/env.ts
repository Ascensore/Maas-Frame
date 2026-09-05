/**
 * Env parsers the media worker can import without pulling Prisma or the
 * Next.js feature-flag module. Keep each of these in lockstep with its
 * counterpart in lib/feature-flags.ts; they do not share a default, so the
 * rule is written out per flag.
 */

/** Only the string "true" (any case) counts, as `isDiarizationFeatureEnabled` does. */
export function isTruthyEnvFlag(value: string | undefined): boolean {
  return (value ?? '').trim().toLowerCase() === 'true';
}

export function isDiarizationEnvEnabled(
  env: NodeJS.Dict<string | undefined> = process.env
): boolean {
  return isTruthyEnvFlag(env.OPENFRAME_ENABLE_DIARIZATION);
}

/**
 * Mirror of `isTranscriptionFeatureEnabled` in lib/feature-flags.ts for the
 * worker: on unless the flag is literally "false".
 */
export function isTranscriptionEnvEnabled(
  env: NodeJS.Dict<string | undefined> = process.env
): boolean {
  return (env.OPENFRAME_ENABLE_TRANSCRIPTION ?? '').trim().toLowerCase() !== 'false';
}
