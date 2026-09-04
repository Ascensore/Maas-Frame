import { describe, expect, it } from 'vitest';
import { analyseSpeech, type Beat } from '@/lib/rough-cut/beats';
import { SILENCE_AGGRESSIVENESS } from '@/lib/rough-cut/brief';
import {
  cleanlinessScore,
  groupTakes,
  rejectedTakeCuts,
  selectTakes,
  type TakeCandidate,
} from '@/lib/rough-cut/takes';
import {
  contentTokens,
  countRestarts,
  endsSentence,
  fillerWordsFor,
  jaccard,
  normalizeWord,
  trigrams,
} from '@/lib/rough-cut/text';
import type { TranscriptSegmentRow } from '@/lib/rough-cut/transcript-source';

const EN = fillerWordsFor('en');
const IT = fillerWordsFor('it');
const MEDIUM = SILENCE_AGGRESSIVENESS.medium;

function spoken(at: number, text: string, gap = 0.1): TranscriptSegmentRow {
  const words = text.split(' ').map((word, index) => ({
    start: at + index * (0.3 + gap),
    end: at + index * (0.3 + gap) + 0.3,
    text: word,
  }));
  return {
    startSec: words[0]!.start,
    endSec: words[words.length - 1]!.end,
    speaker: null,
    text,
    words,
  };
}

function beatAt(at: number, text: string, versionId = 'v', gap = 0.1): Beat {
  const analysis = analyseSpeech([spoken(at, text, gap)], {
    versionId,
    durationSeconds: 100_000,
    policy: SILENCE_AGGRESSIVENESS.low,
  });
  return analysis.beats[0]!;
}

function candidate(
  at: number,
  text: string,
  options: { energy?: number | null; versionId?: string; gap?: number } = {}
): TakeCandidate {
  return {
    beat: beatAt(at, text, options.versionId, options.gap),
    timelineStart: at,
    energy: options.energy ?? null,
  };
}

describe('text helpers', () => {
  it('normalises words and strips fillers per language', () => {
    expect(normalizeWord('“Market,”')).toBe('market');
    expect(normalizeWord("don't")).toBe("don't");
    expect(contentTokens(['So', 'um', 'the', 'Market.'], EN)).toEqual(['so', 'the', 'market']);
    expect(contentTokens(['allora', 'ehm', 'il', 'mercato'], IT)).toEqual([
      'allora',
      'il',
      'mercato',
    ]);
    expect(contentTokens(['um', 'ehm'], fillerWordsFor('de'))).toEqual(['um', 'ehm']);
    expect(fillerWordsFor('en-US').has('um')).toBe(true);
  });

  it('shingles and compares', () => {
    expect([...trigrams(['a', 'b', 'c', 'd'])]).toEqual(['a b c', 'b c d']);
    expect([...trigrams(['thank', 'you'])]).toEqual(['thank you']);
    expect(jaccard(new Set(['a', 'b']), new Set(['b', 'c']))).toBeCloseTo(1 / 3);
    expect(jaccard(new Set(), new Set())).toBe(0);
  });

  it('spots a sentence end and a restart within three seconds', () => {
    expect(endsSentence('done.')).toBe(true);
    expect(endsSentence('done?”')).toBe(true);
    expect(endsSentence('wait…')).toBe(true);
    expect(endsSentence('done, and')).toBe(false);
    const words = [
      { start: 0, end: 0.2, text: 'so' },
      { start: 0.3, end: 0.5, text: 'the' },
      { start: 1.0, end: 1.2, text: 'so' },
      { start: 1.3, end: 1.5, text: 'the' },
      { start: 5.0, end: 5.2, text: 'so' },
      { start: 5.3, end: 5.5, text: 'the' },
    ];
    expect(countRestarts(words)).toBe(1);
  });
});

describe('groupTakes', () => {
  it('groups similar beats within the window, transitively, and leaves short lines alone', () => {
    // 0 and 2 share only three trigrams (well under the threshold); both are
    // similar to 1, so the group exists through 1 alone.
    const candidates = [
      candidate(0, 'our revenue this year doubled to four million dollars'),
      candidate(
        30,
        'um our revenue this year doubled to four million dollars and we are now profitable in europe'
      ),
      candidate(60, 'doubled to four million dollars and we are now profitable in europe and asia'),
      candidate(90, 'the team is now twelve people across two offices'),
      candidate(120, 'thank you'),
      candidate(150, 'thank you'),
      candidate(1000, 'our revenue this year doubled to four million dollars'),
    ];

    expect(groupTakes(candidates, { fillers: EN })).toEqual([[0, 1, 2]]);
    expect(groupTakes([candidates[0]!, candidates[2]!], { fillers: EN })).toEqual([]);
  });
});

describe('cleanlinessScore', () => {
  it('penalises fillers once, restarts twice, and stalls once, per minute', () => {
    const clean = beatAt(0, 'we shipped the product on time and under budget');
    const messy = beatAt(0, 'we um shipped the um product on time');

    expect(cleanlinessScore(clean, EN, MEDIUM.maxKeptGapInsideBeatSeconds)).toBe(0);
    // Eight words at 0.4 s pitch: a 3.1 s beat with two fillers, so 2 / (3.1 / 60).
    expect(cleanlinessScore(messy, EN, MEDIUM.maxKeptGapInsideBeatSeconds)).toBeCloseTo(
      -2 / (3.1 / 60),
      3
    );

    // One restart ("so the, so the") in a 3.1 s beat counts twice: 2 / (3.1 / 60).
    const restarted = beatAt(0, 'so the so the market grew very fast');
    expect(cleanlinessScore(restarted, EN, MEDIUM.maxKeptGapInsideBeatSeconds)).toBeCloseTo(
      -2 / (3.1 / 60),
      3
    );

    // Seven words (2.7 s) with a 1.0 s stall inserted: one long pause over 3.7 s.
    const stalled = beatAt(0, 'we shipped the product on time and');
    stalled.words.slice(4).forEach((word) => {
      word.start += 1.0;
      word.end += 1.0;
    });
    stalled.end += 1.0;
    expect(cleanlinessScore(stalled, EN, MEDIUM.maxKeptGapInsideBeatSeconds)).toBeCloseTo(
      -1 / (3.7 / 60),
      3
    );

    // A beat shorter than a second is scored as if it lasted one: one filler → −60.
    expect(cleanlinessScore(beatAt(0, 'um'), EN, MEDIUM.maxKeptGapInsideBeatSeconds)).toBe(-60);
  });
});

describe('selectTakes', () => {
  const line = 'our revenue this year doubled to four million dollars';

  it('keeps the cleanest take, then the most energetic, then the most recent', () => {
    const byCleanliness = selectTakes(
      [candidate(0, `um ${line}`), candidate(30, line), candidate(60, `${line} um`)],
      { fillers: EN, ranking: ['cleanliness', 'energy'], longPauseSeconds: 0.8 }
    );
    expect(byCleanliness.map((decision) => decision.keptIndex)).toEqual([1]);

    const byEnergy = selectTakes(
      [
        candidate(0, line, { energy: 0.2 }),
        candidate(30, line, { energy: 0.9 }),
        candidate(60, line, { energy: 0.5 }),
      ],
      { fillers: EN, ranking: ['cleanliness', 'energy'], longPauseSeconds: 0.8 }
    );
    expect(byEnergy.map((decision) => decision.keptIndex)).toEqual([1]);

    const byRecency = selectTakes([candidate(0, line), candidate(30, line), candidate(60, line)], {
      fillers: EN,
      ranking: ['cleanliness', 'energy'],
      longPauseSeconds: 0.8,
    });
    expect(byRecency.map((decision) => decision.keptIndex)).toEqual([2]);
  });

  it('follows the ranking order and ignores script_match', () => {
    const decisions = selectTakes(
      [candidate(0, `um ${line}`, { energy: 0.9 }), candidate(30, line, { energy: 0.1 })],
      { fillers: EN, ranking: ['script_match', 'energy', 'cleanliness'], longPauseSeconds: 0.8 }
    );
    expect(decisions.map((decision) => decision.keptIndex)).toEqual([0]);
  });

  it('turns the losers into REJECTED_TAKE cuts that name the kept take', () => {
    const candidates = [
      candidate(0, `um ${line}`, { versionId: 'take-1' }),
      candidate(30, line, { versionId: 'take-2' }),
    ];
    const [decision] = selectTakes(candidates, {
      fillers: EN,
      ranking: ['cleanliness', 'energy'],
      longPauseSeconds: 0.8,
    });

    const cuts = rejectedTakeCuts(candidates, decision!);
    expect(cuts).toHaveLength(1);
    expect(cuts[0]).toMatchObject({
      versionId: 'take-1',
      start: 0,
      code: 'REJECTED_TAKE',
      summary: `Take 1 of 2; kept take 2 (“${line}”)`,
      text: `um ${line}`,
    });
    // Ten words at 0.4 s pitch end at 9 × 0.4 + 0.3.
    expect(cuts[0]!.end).toBeCloseTo(3.9, 6);
  });
});
