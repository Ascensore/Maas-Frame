import { describe, expect, it } from 'vitest';
import { analyseSpeech, type Beat } from '@/lib/rough-cut/beats';
import { SILENCE_AGGRESSIVENESS } from '@/lib/rough-cut/brief';
import {
  alignBeatToScript,
  parseScript,
  rankingWithScript,
  scriptCoverageWarnings,
  scriptTakeGroups,
  splitScriptLines,
} from '@/lib/rough-cut/script';
import { fillerWordsFor } from '@/lib/rough-cut/text';

const EN = fillerWordsFor('en');

function beatAt(at: number, text: string): Beat {
  const words = text.split(' ').map((word, index) => ({
    start: at + index * 0.4,
    end: at + index * 0.4 + 0.3,
    text: word,
  }));
  return analyseSpeech(
    [
      {
        startSec: words[0]!.start,
        endSec: words[words.length - 1]!.end,
        speaker: null,
        text,
        words,
      },
    ],
    { versionId: 'v', durationSeconds: 100_000, policy: SILENCE_AGGRESSIVENESS.low }
  ).beats[0]!;
}

const SCRIPT =
  'We help founders raise faster.\nOur product does the heavy lifting. Thanks for watching, see you next time!\n\nOK';

describe('splitScriptLines / parseScript', () => {
  it('splits on newlines and sentence ends and drops lines under three words', () => {
    expect(splitScriptLines(SCRIPT)).toEqual([
      'We help founders raise faster.',
      'Our product does the heavy lifting.',
      'Thanks for watching, see you next time!',
      'OK',
    ]);
    const lines = parseScript(SCRIPT, EN);
    expect(lines.map((line) => line.index)).toEqual([0, 1, 2]);
    expect(lines[0]!.tokens).toEqual(['we', 'help', 'founders', 'raise', 'faster']);
  });
});

describe('alignBeatToScript', () => {
  const lines = parseScript(SCRIPT, EN);

  it('covers the line a beat reads and scores how much of the beat is on script', () => {
    expect(alignBeatToScript(beatAt(0, 'we help founders raise faster'), lines, EN)).toEqual({
      lines: [0],
      score: 1,
    });
  });

  it('scores a paraphrase below a verbatim read and covers nothing when too different', () => {
    const paraphrase = alignBeatToScript(
      beatAt(0, 'we help founders raise much faster'),
      lines,
      EN
    );
    expect(paraphrase.lines).toEqual([0]);
    expect(paraphrase.score).toBeCloseTo(0.5);
    expect(alignBeatToScript(beatAt(0, 'completely unrelated words here'), lines, EN)).toEqual({
      lines: [],
      score: 0,
    });
  });

  it('can cover two lines read back to back', () => {
    const both = alignBeatToScript(
      beatAt(0, 'we help founders raise faster our product does the heavy lifting'),
      lines,
      EN
    );
    expect(both.lines).toEqual([0, 1]);
  });
});

describe('scriptTakeGroups', () => {
  it('groups beats that cover the same line inside the window and splits beyond it', () => {
    const candidates = [{ timelineStart: 0 }, { timelineStart: 30 }, { timelineStart: 2000 }];
    const alignments = [
      { lines: [0], score: 1 },
      { lines: [0], score: 0.7 },
      { lines: [0], score: 1 },
    ];
    expect(scriptTakeGroups(candidates, alignments, 600)).toEqual([[0, 1]]);
    expect(
      scriptTakeGroups(candidates, [alignments[0]!, { lines: [1], score: 1 }, alignments[2]!], 600)
    ).toEqual([]);
  });
});

describe('scriptCoverageWarnings / rankingWithScript', () => {
  it('names unspoken lines and counts off-script beats', () => {
    const lines = parseScript(SCRIPT, EN);
    const warnings = scriptCoverageWarnings(lines, [
      { lines: [0], score: 1 },
      { lines: [], score: 0.1 },
    ]);
    expect(warnings.map((warning) => warning.code)).toEqual([
      'script-lines-missing',
      'off-script-beats',
    ]);
    expect(warnings[0]!.message).toContain('2 of 3 script lines');
    expect(warnings[0]!.message).toContain('Our product does the heavy lifting.');
    expect(scriptCoverageWarnings(lines, [{ lines: [0, 1, 2], score: 1 }])).toEqual([]);
  });

  it('puts script match first and keeps the rest in order', () => {
    expect(rankingWithScript(['cleanliness', 'energy'])).toEqual([
      'script_match',
      'cleanliness',
      'energy',
    ]);
    expect(rankingWithScript(['energy', 'script_match'])).toEqual(['script_match', 'energy']);
  });
});
