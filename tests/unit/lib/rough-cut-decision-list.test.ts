import { describe, expect, it } from 'vitest';
import { parseRoughCutDecisionList } from '@/lib/rough-cut/decision-list';

const VALID = {
  version: 1 as const,
  edits: [
    {
      timelineStartSeconds: 0,
      timelineEndSeconds: 2,
      inSeconds: 1,
      outSeconds: 3,
      sourceVersionId: 'ver-a',
      cameraRole: 'A',
      targetTrack: 1,
    },
  ],
  clips: [
    {
      versionId: 'ver-a',
      videoId: 'vid-a',
      role: 'A',
      offsetSeconds: 0,
      durationSeconds: 10,
      track: 2,
      fileName: '01-Cam A-v1.mp4',
      targetUrl: './media/01-Cam A-v1.mp4',
    },
  ],
  rate: { num: 24, den: 1, dropFrame: false },
};

describe('parseRoughCutDecisionList', () => {
  it('returns a version-1 list that has edits, clips, and a rate', () => {
    expect(parseRoughCutDecisionList(VALID)).toEqual(VALID);
  });

  it('returns null for garbage, a missing rate, or a newer version', () => {
    expect(parseRoughCutDecisionList(null)).toBeNull();
    expect(parseRoughCutDecisionList({ version: 1, edits: [] })).toBeNull();
    expect(parseRoughCutDecisionList({ ...VALID, version: 2 })).toBeNull();
    expect(
      parseRoughCutDecisionList({
        ...VALID,
        edits: [{ ...VALID.edits[0], sourceVersionId: '' }],
      })
    ).toBeNull();
  });
});
