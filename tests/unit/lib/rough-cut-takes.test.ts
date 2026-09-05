import { describe, expect, it } from 'vitest';
import { analyseSpeech, cutWordsFromBeat, type Beat } from '@/lib/rough-cut/beats';
import { SILENCE_AGGRESSIVENESS } from '@/lib/rough-cut/brief';
import {
  alignBeatToScript,
  parseScript,
  rankingWithScript,
  scriptTakeGroups,
} from '@/lib/rough-cut/script';
import {
  cleanlinessScore,
  coverageOf,
  groupTakes,
  rejectedTakeCut,
  replacedTakeCut,
  resolveTakes,
  selectTakes,
  type TakeCandidate,
} from '@/lib/rough-cut/takes';
import {
  containment,
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

  it('measures containment from the smaller set', () => {
    expect(containment(new Set(['a', 'b', 'c', 'd']), new Set(['c', 'd']))).toBe(1);
    expect(containment(new Set(['c', 'x']), new Set(['a', 'b', 'c', 'd']))).toBe(0.5);
    expect(containment(new Set(), new Set(['a']))).toBe(0);
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

  it('groups a retake that only repeats the tail of a longer take', () => {
    const first = candidate(
      0,
      'in this video we look at how founders raise their seed round faster than before and what investors actually want to see'
    );
    const tail = candidate(20, 'how founders raise their seed round faster than before');
    // Twenty trigrams against seven, all seven shared: Jaccard is 7/20, so only
    // containment can see that the retake is a piece of the first take.
    expect(
      jaccard(
        trigrams(
          contentTokens(
            first.beat.words.map((word) => word.text),
            EN
          )
        ),
        trigrams(
          contentTokens(
            tail.beat.words.map((word) => word.text),
            EN
          )
        )
      )
    ).toBeLessThan(0.5);
    expect(groupTakes([first, tail], { fillers: EN })).toEqual([[0, 1]]);
  });

  it('does not treat a short repeated phrase as a contained take', () => {
    const long = candidate(0, 'thank you so much for being here with us today everyone');
    // Five content tokens, wholly contained in the longer beat, but under the
    // floor a contained retake has to clear.
    const short = candidate(30, 'thank you so much for');
    expect(groupTakes([long, short], { fillers: EN })).toEqual([]);
  });

  it('unions externally supplied groups into the take groups', () => {
    const a = candidate(0, 'our product does the heavy lifting for you');
    const b = candidate(15, 'the platform handles all of the boring parts');
    expect(groupTakes([a, b], { fillers: EN })).toEqual([]);
    expect(groupTakes([a, b], { fillers: EN, alsoGroup: [[0, 1]] })).toEqual([[0, 1]]);
    // An index with no candidate drops out; the members around it still union.
    expect(groupTakes([a, b], { fillers: EN, alsoGroup: [[9, 0, 1]] })).toEqual([[0, 1]]);
    expect(groupTakes([a, b], { fillers: EN, alsoGroup: [[0, 9]] })).toEqual([]);
  });

  it('will not call a stock phrase a take of a beat several times its length', () => {
    const phrase = candidate(120, 'at the end of the day');
    // Six content tokens wholly contained in both beats. Containment alone
    // would group either pair; only the length ratio tells them apart.
    const long = candidate(
      0,
      'we spent a long time thinking about how to price this new product and we decided that at the end of the day simplicity wins'
    );
    expect(groupTakes([long, phrase], { fillers: EN })).toEqual([]);

    const shorter = candidate(
      0,
      'we thought about it a while and we decided that at the end of the day simplicity wins'
    );
    // Eighteen tokens against six is exactly the ratio the guard allows.
    expect(groupTakes([shorter, phrase], { fillers: EN })).toEqual([[0, 1]]);
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

  it('ranks by script match first when asked, then falls through to cleanliness', () => {
    // Cleanliness alone would keep the first take; only the script says otherwise.
    const offScript = { ...candidate(0, 'we help founders raise faster'), scriptMatch: 0.4 };
    const onScript = { ...candidate(10, 'we help um founders raise faster'), scriptMatch: 1 };
    const decisions = selectTakes([offScript, onScript], {
      fillers: EN,
      ranking: rankingWithScript(['cleanliness', 'energy']),
      longPauseSeconds: MEDIUM.maxKeptGapInsideBeatSeconds,
    });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.keptIndex).toBe(1);
    expect(decisions[0]!.scores.get(1)?.scriptMatch).toBe(1);
  });
});

describe('resolveTakes', () => {
  const options = {
    fillers: EN,
    ranking: ['cleanliness', 'energy'] as const,
    longPauseSeconds: MEDIUM.maxKeptGapInsideBeatSeconds,
  };

  it('measures how much of a beat a reference already says and where', () => {
    const tokens = ['we', 'help', 'founders', 'raise', 'faster', 'thanks', 'for', 'watching'];
    const reference = new Set(['thanks for watching']);
    expect(coverageOf(tokens, reference)).toEqual({ fraction: 3 / 8, first: 5, last: 7 });
    expect(coverageOf(tokens, new Set())).toEqual({ fraction: 0, first: null, last: null });
  });

  it('replaces the tail of a long take with a cleaner retake of that tail', () => {
    const long = candidate(
      0,
      'in this video we look at how um founders raise their seed round faster than before'
    );
    const retake = candidate(30, 'how founders raise their seed round faster than before');
    const [resolution] = resolveTakes([long, retake], {
      ...options,
      ranking: [...options.ranking],
    });
    expect(resolution?.rejected).toEqual([]);
    expect(resolution?.kept.map((entry) => entry.index)).toEqual([0, 1]);
    // The retake covers the long take's last nine tokens ("how … before"), a
    // suffix that leaves six, so the long take gives that tail up instead of
    // losing the six tokens only it says.
    const spliced = resolution?.kept.find((entry) => entry.index === 0)?.cuts;
    expect(spliced).toHaveLength(1);
    expect(spliced?.[0]).toMatchObject({ coveredBy: 1 });
    expect(long.beat.words[spliced![0]!.wordStart]?.text).toBe('how');
    expect(spliced?.[0]?.wordEnd).toBe(long.beat.words.length);
    expect(resolution?.duplicatesKept).toBe(0);
  });

  it('rejects a retake of a line in the middle of a longer take, keeping the long take intact', () => {
    const long = candidate(
      0,
      'we help founders raise faster our product does the heavy lifting thanks for watching everyone'
    );
    const retake = candidate(40, 'our product does the heavy lifting');
    const [resolution] = resolveTakes([long, retake], {
      ...options,
      ranking: [...options.ranking],
    });
    expect(resolution?.kept).toEqual([{ index: 0, cuts: [] }]);
    expect(resolution?.rejected).toEqual([{ index: 1, coveredBy: 0 }]);
  });

  it('trims the flubbed line off the lower-ranked of two adjacent beats that share it', () => {
    const flub = candidate(
      0,
      'we help founders raise faster our um product does um the heavy lifting'
    );
    const good = candidate(12, 'our product does the heavy lifting thanks for watching everyone');
    // Four shared trigrams out of nine and eight: Jaccard 4/13 and containment
    // 4/8 are both under their thresholds, so only a script signal groups these
    // two. `alsoGroup` stands in for it here.
    expect(groupTakes([flub, good], { fillers: EN })).toEqual([]);
    const [resolution] = resolveTakes([flub, good], {
      ...options,
      ranking: [...options.ranking],
      alsoGroup: [[0, 1]],
    });
    expect(resolution?.rejected).toEqual([]);
    const trimmed = resolution?.kept.find((entry) => entry.index === 0)?.cuts;
    expect(trimmed).toHaveLength(1);
    expect(flub.beat.words[trimmed![0]!.wordStart]?.text).toBe('our');
    expect(trimmed?.[0]?.wordEnd).toBe(flub.beat.words.length);
    expect(trimmed?.[0]?.coveredBy).toBe(1);
    expect(resolution?.kept.find((entry) => entry.index === 1)?.cuts).toEqual([]);
  });

  it('replaces only the anchor edge the pickup is next to on the timeline', () => {
    const script = parseScript(
      'We help founders raise faster.\nOur product does the heavy lifting.\nThanks for watching everyone today.',
      EN
    );
    const candidates = [
      candidate(
        0,
        'we help um founders raise faster our product does um the heavy lifting thanks for um watching everyone today'
      ),
      candidate(40, 'we help founders raise faster'),
      candidate(50, 'our product does the heavy lifting'),
      candidate(60, 'thanks for watching everyone today'),
    ];
    const alignments = candidates.map((entry) => alignBeatToScript(entry.beat, script, EN));
    expect(alignments.map((alignment) => alignment.lines)).toEqual([[0, 1, 2], [0], [1], [2]]);

    const [resolution] = resolveTakes(candidates, {
      ...options,
      ranking: [...options.ranking],
      scriptLines: script.lines,
      alignments,
      // The script is what says these four are takes of the same lines; their
      // wording alone groups only the second pickup with the full read.
      alsoGroup: scriptTakeGroups(candidates, alignments, 600),
    });

    // Every pickup is cleaner than the full read, but the program keeps source
    // order: only the last line's pickup sits where the material it replaces
    // does, so only it may replace the full read's tail.
    expect(resolution?.rejected).toEqual([
      { index: 2, coveredBy: 0 },
      { index: 1, coveredBy: 0 },
    ]);
    expect(resolution?.kept.map((entry) => entry.index)).toEqual([0, 3]);
    expect(resolution?.kept.find((entry) => entry.index === 3)?.cuts).toEqual([]);
    const spliced = resolution?.kept.find((entry) => entry.index === 0)?.cuts;
    expect(spliced).toEqual([
      { wordStart: 13, wordEnd: candidates[0]!.beat.words.length, coveredBy: 3 },
    ]);
    expect(candidates[0]!.beat.words[13]?.text).toBe('thanks');
    expect(resolution?.duplicatesKept).toBe(0);
  });

  it('trims the shared head off the lower-ranked take that comes after it', () => {
    const clean = candidate(0, 'we help founders raise faster our product does the heavy lifting');
    const messy = candidate(
      20,
      'our um product does um the heavy lifting thanks for watching everyone today'
    );
    // Four shared trigrams out of nine each: under both thresholds, so the
    // group stands in for the script signal here too.
    const [resolution] = resolveTakes([clean, messy], {
      ...options,
      ranking: [...options.ranking],
      alsoGroup: [[0, 1]],
    });
    expect(resolution?.rejected).toEqual([]);
    const trimmed = resolution?.kept.find((entry) => entry.index === 1)?.cuts;
    // The head is dropped from the later take, so the line survives where it
    // was first said and the take keeps the material only it has.
    expect(trimmed).toEqual([{ wordStart: 0, wordEnd: 8, coveredBy: 0 }]);
    expect(messy.beat.words[8]?.text).toBe('thanks');
    expect(resolution?.duplicatesKept).toBe(0);
  });

  it('keeps a shared tail that the take before it already said, and counts it', () => {
    const clean = candidate(
      0,
      'our product does the heavy lifting thanks for watching everyone today'
    );
    const messy = candidate(
      20,
      'we help um founders raise faster our um product does the heavy lifting'
    );
    const [resolution] = resolveTakes([clean, messy], {
      ...options,
      ranking: [...options.ranking],
      alsoGroup: [[0, 1]],
    });
    // Trimming the later take's tail would leave the shared line standing
    // before the material that led into it, so both takes are kept whole and
    // the duplicate is reported instead.
    expect(resolution?.rejected).toEqual([]);
    expect(resolution?.kept).toEqual([
      { index: 0, cuts: [] },
      { index: 1, cuts: [] },
    ]);
    expect(resolution?.duplicatesKept).toBe(1);
  });

  it('still rejects a plain duplicate and keeps the cleaner one', () => {
    const first = candidate(0, 'we help um founders raise faster today');
    const second = candidate(10, 'we help founders raise faster today');
    const [resolution] = resolveTakes([first, second], {
      ...options,
      ranking: [...options.ranking],
    });
    expect(resolution?.kept).toEqual([{ index: 1, cuts: [] }]);
    expect(resolution?.rejected).toEqual([{ index: 0, coveredBy: 1 }]);
  });

  it('turns a spliced span into a cut that names the take that replaced it', () => {
    const candidates = [
      candidate(
        0,
        'in this video we look at how um founders raise their seed round faster than before',
        {
          versionId: 'take-1',
        }
      ),
      candidate(30, 'how founders raise their seed round faster than before', {
        versionId: 'take-2',
      }),
    ];
    const [resolution] = resolveTakes(candidates, { ...options, ranking: [...options.ranking] });
    const span = resolution!.kept.find((entry) => entry.index === 0)!.cuts[0]!;
    const removed = cutWordsFromBeat(candidates[0]!.beat, [span]).removed[0]!;

    expect(replacedTakeCut(candidates, 0, span.coveredBy, removed)).toEqual({
      versionId: 'take-1',
      start: removed.start,
      end: removed.end,
      code: 'REJECTED_TAKE',
      summary:
        'Replaced by the take at 30.0s (“how founders raise their seed round faster than before”)',
      text: 'how um founders raise their seed round faster than before',
    });
  });

  it('names the group position of a rejected member and of the take that covers it', () => {
    const candidates = [
      candidate(0, 'we help um founders raise faster today', { versionId: 'take-1' }),
      candidate(10, 'we help founders raise faster today', { versionId: 'take-2' }),
    ];
    const [resolution] = resolveTakes(candidates, { ...options, ranking: [...options.ranking] });
    const entry = resolution!.rejected[0]!;

    const cut = rejectedTakeCut(candidates, entry.index, entry.coveredBy, resolution!);
    expect(cut).toMatchObject({
      versionId: 'take-1',
      start: 0,
      code: 'REJECTED_TAKE',
      summary: 'Take 1 of 2; kept take 2 (“we help founders raise faster today”)',
      text: 'we help um founders raise faster today',
    });
    // Seven words at 0.4 s pitch end at 6 × 0.4 + 0.3.
    expect(cut.end).toBeCloseTo(2.7, 6);
  });

  it('keeps both takes and counts the duplicate when neither can give the line up', () => {
    // Each take says the shared line in its middle, so no edge cut exists and
    // neither is redundant: the cut says the line twice and the caller warns.
    const first = candidate(
      0,
      'we help founders raise faster our product does the heavy lifting and we ship on time'
    );
    const second = candidate(
      40,
      'the team is twelve people our product does the heavy lifting across two offices in europe'
    );
    const [resolution] = resolveTakes([first, second], {
      ...options,
      ranking: [...options.ranking],
      alsoGroup: [[0, 1]],
    });
    expect(resolution?.rejected).toEqual([]);
    expect(resolution?.kept.map((entry) => [entry.index, entry.cuts])).toEqual([
      [0, []],
      [1, []],
    ]);
    expect(resolution?.duplicatesKept).toBe(1);
  });
});
