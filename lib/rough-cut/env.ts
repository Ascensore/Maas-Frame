/**
 * Env parsers the media worker can import without pulling Prisma or the
 * Next.js feature-flag module. Keep these in lockstep with
 * `isDiarizationFeatureEnabled` in lib/feature-flags.ts: only the string
 * "true" (any case) turns the flag on.
 */
export function isTruthyEnvFlag(value: string | undefined): boolean {
  return (value ?? '').trim().toLowerCase() === 'true';
}

export function isDiarizationEnvEnabled(
  env: NodeJS.Dict<string | undefined> = process.env
): boolean {
  return isTruthyEnvFlag(env.OPENFRAME_ENABLE_DIARIZATION);
}
