import { after } from 'next/server';
import { logError } from '@/lib/logger';
import { runTranscriptionForVersion } from '@/lib/transcription/run-version';

/**
 * Run STT after the HTTP response so create/transcribe can return 202. On
 * Vercel this uses the route's remaining `maxDuration`. Tests replace this
 * module so VIDEO/AUDIO creates do not hit R2 or Whisper.
 */
export function scheduleVersionTranscription(versionId: string, language = 'en'): void {
  const work = () =>
    runTranscriptionForVersion({ versionId, language }).catch((error) => {
      logError('Inline transcription failed:', error);
    });

  try {
    after(work);
  } catch {
    void work();
  }
}
