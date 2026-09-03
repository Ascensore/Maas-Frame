export type RmsSample = {
  versionId: string;
  rms: number;
};

export type RmsPick = {
  versionId: string;
  confidence: number;
};

/**
 * Pick the camera whose window has the highest RMS. Confidence is the ratio
 * of the winner to the runner-up (1 when there is no second sample or the
 * runner-up is silent). The assemble job records a warning below 1.2.
 */
export function pickHighestRmsCamera(samples: RmsSample[]): RmsPick | null {
  if (samples.length === 0) return null;

  let best = samples[0]!;
  let second = -1;
  for (let index = 1; index < samples.length; index += 1) {
    const sample = samples[index]!;
    if (sample.rms > best.rms) {
      second = best.rms;
      best = sample;
    } else if (sample.rms > second) {
      second = sample.rms;
    }
  }

  return {
    versionId: best.versionId,
    confidence: second > 0 ? best.rms / second : 1,
  };
}

export const LOW_ATTRIBUTION_CONFIDENCE = 1.2;
