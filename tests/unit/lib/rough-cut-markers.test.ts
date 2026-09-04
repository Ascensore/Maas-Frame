import { describe, expect, it } from 'vitest';
import { analyseSpeech, type Beat } from '@/lib/rough-cut/beats';
import { SILENCE_AGGRESSIVENESS } from '@/lib/rough-cut/brief';
import { exportMarkers } from '@/lib/rough-cut/export-markers';
import {
  cutMarkerPoint,
  findIllustrationCue,
  findJargon,
  illustrationCuesFor,
  markersForBeat,
  placeMarkers,
  type SourceMarker,
} from '@/lib/rough-cut/markers';
import { fillerWordsFor } from '@/lib/rough-cut/text';
import type { CutIsland, EditDecision, RoughCutDecisionList } from '@/lib/rough-cut/types';

const RATE = { num: 24, den: 1, dropFrame: false };
const EN = fillerWordsFor('en');
const BOTH = { infographicOnJargon: true, brollOnIllustration: true };

/** 0.3 s words at a 0.4 s pitch, so word n starts at `at + 0.4n`. */
function beatAt(at: number, text: string, versionId = 'ver-a'): Beat {
  const words = text.split(' ').map((word, index) => ({
    start: at + index * 0.4,
    end: at + index * 0.4 + 0.3,
    text: word,
  }));
  const analysis = analyseSpeech(
    [
      {
        startSec: words[0]!.start,
        endSec: words[words.length - 1]!.end,
        speaker: null,
        text,
        words,
      },
    ],
    { versionId, durationSeconds: 100_000, policy: SILENCE_AGGRESSIVENESS.low }
  );
  return analysis.beats[0]!;
}

function edit(
  versionId: string,
  timelineStart: number,
  inSeconds: number,
  outSeconds: number
): EditDecision {
  return {
    timelineStartSeconds: timelineStart,
    timelineEndSeconds: timelineStart + (outSeconds - inSeconds),
    inSeconds,
    outSeconds,
    sourceVersionId: versionId,
    cameraRole: versionId === 'ver-a' ? 'A' : 'B',
    targetTrack: 1,
  };
}

describe('findJargon', () => {
  it('spots an acronym, a figure with a currency symbol or percent, and a capitalised term', () => {
    expect(findJargon(['our', 'KPI', 'dashboard'])).toEqual({ wordIndex: 1, term: 'KPI' });
    expect(findJargon(['we', 'raised', '€4M', 'last', 'year'])).toEqual({
      wordIndex: 2,
      term: '€4M',
    });
    expect(findJargon(['margins', 'hit', '40%', 'in', 'Q3.'])).toEqual({
      wordIndex: 2,
      term: '40%',
    });
    expect(findJargon(['it', 'costs', '$', '400', 'a', 'month'])).toEqual({
      wordIndex: 2,
      term: '$400',
    });
    expect(findJargon(['we', 'closed', 'our', 'Series', 'A', 'in', 'March'])).toEqual({
      wordIndex: 3,
      term: 'Series A',
    });
    expect(findJargon(['up', '40', '%', 'in', 'a', 'year'])).toEqual({ wordIndex: 1, term: '40%' });
    expect(findJargon(['costs', '€', '4'])).toEqual({ wordIndex: 1, term: '€4' });
    expect(findJargon(['three', 'KPIs', 'matter'])).toEqual({ wordIndex: 1, term: 'KPIs' });
    // A segment without word timings is one pseudo-word; the term is still found.
    expect(findJargon(['as you can see our KPI rose'])).toEqual({ wordIndex: 0, term: 'KPI' });
    expect(findJargon(['so the', 'Series A closed'])).toEqual({ wordIndex: 1, term: 'Series A' });
  });

  it('ignores a capitalised phrase at a sentence start, a stoplisted acronym, and plain words', () => {
    expect(findJargon(['Market', 'Research', 'is', 'slow'])).toBeNull();
    expect(findJargon(['done.', 'Market', 'Research', 'is', 'slow'])).toBeNull();
    expect(findJargon(['done.', 'New', 'York', 'City', 'is', 'big'])).toBeNull();
    expect(findJargon(['and', 'I', 'Think', 'so'])).toBeNull();
    expect(findJargon(['in', 'Rome', 'I', 'saw', 'it'])).toBeNull();
    expect(findJargon(['OK', 'so', 'at', '9', 'PM'])).toBeNull();
    expect(findJargon(['we', 'grew', 'to', 'four', 'million'])).toBeNull();
    expect(findJargon(['a', 'six', 'letter', 'SYSTEM'])).toBeNull();
    expect(findJargon([])).toBeNull();
  });
});

describe('findIllustrationCue', () => {
  it('matches a cue across fillers and punctuation and reports the first word of it', () => {
    expect(
      findIllustrationCue(['As,', 'um,', 'you', 'can', 'see,'], illustrationCuesFor('en'), EN)
    ).toEqual({
      wordIndex: 0,
      cue: 'as you can see',
    });
    expect(
      findIllustrationCue(
        ['e', 'come', 'vedete', 'qui'],
        illustrationCuesFor('it'),
        fillerWordsFor('it')
      )
    ).toEqual({ wordIndex: 1, cue: 'come vedete' });
    // The index is the word's, not the position among the filler-free tokens.
    expect(
      findIllustrationCue(['um', 'uh', 'as', 'you', 'can', 'see'], illustrationCuesFor('en'), EN)
    ).toEqual({ wordIndex: 2, cue: 'as you can see' });
    expect(findIllustrationCue(['Here’s', 'the', 'plan'], illustrationCuesFor('en'), EN)).toEqual({
      wordIndex: 0,
      cue: "here's",
    });
    expect(findIllustrationCue(['here', 'we', 'go'], illustrationCuesFor('en'), EN)).toBeNull();
    expect(findIllustrationCue(['ecco'], illustrationCuesFor('de'), EN)).toBeNull();
  });
});

describe('markersForBeat', () => {
  it('produces one marker per kind, at the matching word, per the brief’s rules', () => {
    const beat = beatAt(10, 'as you can see our ARR doubled and our MRR too');
    const both = markersForBeat(beat, {
      rules: BOTH,
      cues: illustrationCuesFor('en'),
      fillers: EN,
    });
    expect(both).toEqual([
      {
        versionId: 'ver-a',
        kind: 'INFOGRAPHIC',
        start: 12,
        end: beat.end,
        title: 'Infographic: ARR',
        reason: {
          code: 'MARKER_JARGON',
          summary: '“ARR” in “as you can see our ARR doubled and our MRR too”',
        },
      },
      {
        versionId: 'ver-a',
        kind: 'BROLL',
        start: 10,
        end: beat.end,
        title: 'B-roll: as you can see',
        reason: {
          code: 'MARKER_ILLUSTRATION',
          summary: '“as you can see” in “as you can see our ARR doubled and our MRR too”',
        },
      },
    ]);

    const onlyBroll = markersForBeat(beat, {
      rules: { infographicOnJargon: false, brollOnIllustration: true },
      cues: illustrationCuesFor('en'),
      fillers: EN,
    });
    expect(onlyBroll.map((marker) => marker.kind)).toEqual(['BROLL']);
    expect(
      markersForBeat(beat, {
        rules: { infographicOnJargon: false, brollOnIllustration: false },
        cues: illustrationCuesFor('en'),
        fillers: EN,
      })
    ).toEqual([]);
  });
});

describe('placeMarkers', () => {
  const marker = (versionId: string, start: number, end: number): SourceMarker => ({
    versionId,
    kind: 'INFOGRAPHIC',
    start,
    end,
    title: 'Infographic: KPI',
    reason: { code: 'MARKER_JARGON', summary: 'KPI' },
  });

  it('maps a source point through the edit that keeps it and clips the duration to that edit', () => {
    // Clip A 0–10 s on the timeline as [2,6) and [8,10); source 6–8 was removed.
    const edits = [edit('ver-a', 0, 2, 6), edit('ver-a', 4, 8, 10)];
    const placed = placeMarkers(
      [marker('ver-a', 3, 9), marker('ver-a', 7, 9), marker('ver-a', 8.5, 9)],
      edits,
      () => 0,
      RATE
    );
    expect(placed).toEqual([
      {
        key: 'ver-a:INFOGRAPHIC:72',
        kind: 'INFOGRAPHIC',
        timelineSeconds: 1,
        durationSeconds: 3,
        title: 'Infographic: KPI',
        reason: { code: 'MARKER_JARGON', summary: 'KPI' },
      },
      {
        key: 'ver-a:INFOGRAPHIC:204',
        kind: 'INFOGRAPHIC',
        timelineSeconds: 4.5,
        durationSeconds: 0.5,
        title: 'Infographic: KPI',
        reason: { code: 'MARKER_JARGON', summary: 'KPI' },
      },
    ]);
  });

  it('drops a marker whose word starts exactly where its edit ends', () => {
    const edits = [edit('ver-a', 0, 2, 6), edit('ver-a', 4, 8, 10)];
    expect(placeMarkers([marker('ver-a', 6, 7)], edits, () => 0, RATE)).toEqual([]);
  });

  it('places a marker on the packed multicam timeline even when another camera is up', () => {
    // Cam B sits 1 s later than cam A. The program shows B from continuous 5–9 s,
    // packed after a removed 2–5 s hole, so continuous 6 s is timeline 3 s.
    const offsetOf = (versionId: string) => (versionId === 'ver-b' ? 1 : 0);
    const edits = [edit('ver-a', 0, 0, 2), edit('ver-b', 2, 4, 8)];
    const placed = placeMarkers([marker('ver-a', 6, 6.5)], edits, offsetOf, RATE);
    expect(placed.map((entry) => [entry.timelineSeconds, entry.durationSeconds])).toEqual([
      [3, 0.5],
    ]);
    // A marker in the hole is dropped, and one whose beat ends at its word gets no duration.
    expect(placeMarkers([marker('ver-a', 3, 4)], edits, offsetOf, RATE)).toEqual([]);
    expect(
      placeMarkers([marker('ver-a', 6, 6)], edits, offsetOf, RATE)[0]?.durationSeconds
    ).toBeNull();
  });

  it('sorts by timeline position', () => {
    const edits = [edit('ver-a', 0, 0, 10)];
    const placed = placeMarkers(
      [marker('ver-a', 7, 8), marker('ver-a', 2, 3)],
      edits,
      () => 0,
      RATE
    );
    expect(placed.map((entry) => entry.timelineSeconds)).toEqual([2, 7]);
  });
});

describe('cutMarkerPoint and exportMarkers', () => {
  const cut = (versionId: string, inSeconds: number, outSeconds: number): CutIsland => ({
    key: `${versionId}:${inSeconds * 24}-${outSeconds * 24}`,
    sourceVersionId: versionId,
    inSeconds,
    outSeconds,
    reason: { code: 'DEAD_AIR', summary: `${(outSeconds - inSeconds).toFixed(1)}s of dead air` },
    transcriptText: null,
  });

  it('puts a removed range at the start of what follows it, else the end of what precedes it', () => {
    const edits = [edit('ver-a', 0, 2, 6), edit('ver-a', 4, 8, 10)];
    expect(cutMarkerPoint(cut('ver-a', 6, 8), edits, () => 0)).toBe(4);
    expect(cutMarkerPoint(cut('ver-a', 0, 2), edits, () => 0)).toBe(0);
    expect(cutMarkerPoint(cut('ver-a', 10, 12), edits, () => 0)).toBe(6);
    expect(cutMarkerPoint(cut('ver-a', 6, 8), [], () => 0)).toBeNull();
    // With a gap on the timeline the following edit wins over the preceding one.
    const gapped = [edit('ver-a', 0, 2, 6), edit('ver-a', 5, 8, 10)];
    expect(cutMarkerPoint(cut('ver-a', 6, 8), gapped, () => 0)).toBe(5);
  });

  it('shifts the cut by its own camera’s offset before looking for neighbours', () => {
    const offsetOf = (versionId: string) => (versionId === 'ver-b' ? 1 : 0);
    // Cam B source 0–2 is continuous 1–3; a cut at source 2–3 follows it directly.
    expect(cutMarkerPoint(cut('ver-b', 2, 3), [edit('ver-b', 0, 0, 2)], offsetOf)).toBe(2);
  });

  it('uses the clip offset so a cut on the session camera lands between edits on other cameras', () => {
    const offsetOf = (versionId: string) => (versionId === 'ver-b' ? 1 : 0);
    // Continuous: A 0–2, hole 2–5, B 5–9 (source 4–8 on B). A cut on cam A at 2–5.
    const edits = [edit('ver-a', 0, 0, 2), edit('ver-b', 2, 4, 8)];
    expect(cutMarkerPoint(cut('ver-a', 2, 5), edits, offsetOf)).toBe(2);
  });

  it('orders markers at the same point by kind, so the output is stable', () => {
    const decisions: RoughCutDecisionList = {
      version: 1,
      edits: [edit('ver-a', 0, 2, 6)],
      clips: [
        {
          versionId: 'ver-a',
          videoId: 'vid-a',
          role: 'A',
          offsetSeconds: 0,
          durationSeconds: 12,
          track: 2,
          fileName: 'a.mp4',
          targetUrl: './media/a.mp4',
        },
      ],
      rate: RATE,
      cuts: [{ ...cut('ver-a', 0, 2), transcriptText: 'so the, so the' }],
      markers: [
        {
          key: 'ver-a:INFOGRAPHIC:48',
          kind: 'INFOGRAPHIC',
          timelineSeconds: 0,
          durationSeconds: 1,
          title: 'Infographic: KPI',
          reason: { code: 'MARKER_JARGON', summary: '“KPI”' },
        },
        {
          key: 'ver-a:BROLL:48',
          kind: 'BROLL',
          timelineSeconds: 0,
          durationSeconds: 1,
          title: 'B-roll: here is',
          reason: { code: 'MARKER_ILLUSTRATION', summary: '“here is”' },
        },
      ],
    };
    const exported = exportMarkers(decisions, { includeCuts: true });
    expect(exported.map((marker) => marker.kind)).toEqual(['BROLL', 'CUT', 'INFOGRAPHIC']);
    // A cut with transcript text carries it as the comment.
    expect(exported[1]?.comment).toBe('so the, so the');
  });

  it('lists program markers always and cut markers only when asked, sorted together', () => {
    const decisions: RoughCutDecisionList = {
      version: 1,
      edits: [edit('ver-a', 0, 2, 6), edit('ver-a', 4, 8, 10)],
      clips: [
        {
          versionId: 'ver-a',
          videoId: 'vid-a',
          role: 'A',
          offsetSeconds: 0,
          durationSeconds: 12,
          track: 2,
          fileName: 'a.mp4',
          targetUrl: './media/a.mp4',
        },
      ],
      rate: RATE,
      cuts: [cut('ver-a', 6, 8)],
      markers: [
        {
          key: 'ver-a:BROLL:216',
          kind: 'BROLL',
          timelineSeconds: 5,
          durationSeconds: 1,
          title: 'B-roll: here is',
          reason: { code: 'MARKER_ILLUSTRATION', summary: '“here is”' },
        },
      ],
    };
    expect(
      exportMarkers(decisions, { includeCuts: false }).map((m) => [m.kind, m.timelineSeconds])
    ).toEqual([['BROLL', 5]]);
    expect(exportMarkers(decisions, { includeCuts: true })).toEqual([
      {
        key: 'ver-a:144-192',
        kind: 'CUT',
        timelineSeconds: 4,
        durationSeconds: null,
        title: 'Cut: 2.0s of dead air',
        comment: '2.0s of dead air',
        reason: { code: 'DEAD_AIR', summary: '2.0s of dead air' },
      },
      {
        key: 'ver-a:BROLL:216',
        kind: 'BROLL',
        timelineSeconds: 5,
        durationSeconds: 1,
        title: 'B-roll: here is',
        comment: '“here is”',
        reason: { code: 'MARKER_ILLUSTRATION', summary: '“here is”' },
      },
    ]);
    expect(
      exportMarkers({ ...decisions, markers: undefined, cuts: undefined }, { includeCuts: true })
    ).toEqual([]);
  });
});
