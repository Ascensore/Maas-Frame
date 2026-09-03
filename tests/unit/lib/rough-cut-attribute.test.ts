import { describe, expect, it } from 'vitest';
import { pickHighestRmsCamera } from '@/lib/rough-cut/attribute';

describe('pickHighestRmsCamera', () => {
  it('returns null for an empty list', () => {
    expect(pickHighestRmsCamera([])).toBeNull();
  });

  it('picks the version with the highest RMS and ratios it against the runner-up', () => {
    expect(
      pickHighestRmsCamera([
        { versionId: 'cam-a', rms: 0.1 },
        { versionId: 'cam-b', rms: 0.4 },
        { versionId: 'cam-c', rms: 0.2 },
      ])
    ).toEqual({ versionId: 'cam-b', confidence: 2 });
  });

  it('reports confidence 1 when there is only one camera', () => {
    expect(pickHighestRmsCamera([{ versionId: 'cam-a', rms: 0.5 }])).toEqual({
      versionId: 'cam-a',
      confidence: 1,
    });
  });

  it('reports confidence 1 when every other camera is silent', () => {
    expect(
      pickHighestRmsCamera([
        { versionId: 'cam-a', rms: 0.3 },
        { versionId: 'cam-b', rms: 0 },
      ])
    ).toEqual({ versionId: 'cam-a', confidence: 1 });
  });

  it('keeps the earlier camera when two RMS values are equal', () => {
    expect(
      pickHighestRmsCamera([
        { versionId: 'cam-a', rms: 0.2 },
        { versionId: 'cam-b', rms: 0.2 },
      ])
    ).toEqual({ versionId: 'cam-a', confidence: 1 });
  });
});
