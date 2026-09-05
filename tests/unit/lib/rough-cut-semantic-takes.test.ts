import { describe, expect, it, vi } from 'vitest';
import { generateText } from 'ai';
import { analyseSpeech } from '@/lib/rough-cut/beats';
import { SILENCE_AGGRESSIVENESS } from '@/lib/rough-cut/brief';
import { acceptedSemanticTakePairs, semanticTakeGroups } from '@/lib/rough-cut/semantic-takes';
import { fillerWordsFor } from '@/lib/rough-cut/text';
import type { TakeCandidate } from '@/lib/rough-cut/takes';

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, generateText: vi.fn() };
});

function candidate(at: number, text: string): TakeCandidate {
  const words = text.split(' ').map((word, index) => ({
    start: at + index * 0.4,
    end: at + index * 0.4 + 0.3,
    text: word,
  }));
  const beat = analyseSpeech(
    [{ startSec: at, endSec: words.at(-1)!.end, text, speaker: null, words }],
    { versionId: 'version', durationSeconds: 100, policy: SILENCE_AGGRESSIVENESS.tight }
  ).beats[0]!;
  return { beat, timelineStart: at, energy: null };
}

describe('semanticTakeGroups', () => {
  it('sends transcript pairs only and accepts a high-confidence paraphrased retake', async () => {
    vi.mocked(generateText).mockResolvedValueOnce({
      output: {
        pairs: [{ proposal: 0, sameIntent: true, confidence: 0.92, preferred: 1 }],
      },
    } as never);
    const first = candidate(0, 'our platform removes the manual work from weekly reports');
    const second = candidate(10, 'weekly reporting no longer requires repetitive manual effort');

    const result = await semanticTakeGroups({
      candidates: [first, second],
      fillers: fillerWordsFor('en'),
      model: 'test-model',
    });

    expect(result.groups).toEqual([[0, 1]]);
    expect([...result.preferred]).toEqual([1]);
    const request = vi.mocked(generateText).mock.calls[0]?.[0];
    expect(request?.prompt).toContain('our platform removes the manual work');
    expect(request?.prompt).toContain('weekly reporting no longer requires');
    expect(request?.prompt).not.toMatch(/providerId|videoId|originalUrl|\.mp4/);
  });

  it('rejects incomplete, duplicate, and out-of-range model decisions', () => {
    const proposals = [
      { left: 0, right: 1 },
      { left: 1, right: 2 },
    ];
    const decision = {
      proposal: 0,
      sameIntent: false,
      confidence: 0.5,
      preferred: 0 as const,
    };

    expect(() => acceptedSemanticTakePairs(proposals, [decision])).toThrow(/every proposal/);
    expect(() => acceptedSemanticTakePairs(proposals, [decision, decision])).toThrow(
      /every proposal/
    );
    expect(() =>
      acceptedSemanticTakePairs(proposals, [
        decision,
        { ...decision, proposal: 1 },
        { ...decision, proposal: 1 },
      ])
    ).toThrow(/every proposal/);
    expect(() =>
      acceptedSemanticTakePairs(proposals, [decision, { ...decision, proposal: 2 }])
    ).toThrow(/every proposal/);
  });
});
