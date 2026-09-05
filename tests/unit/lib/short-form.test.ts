import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SHORT_CAPTION_STYLE,
  planShortFormCandidates,
  selectDiverseCandidates,
  sentenceBoundaries,
  shortFormBatchConfigSchema,
  snapShortRange,
  transcriptTextForRange,
  type ShortFormCandidatePlan,
  type ShortFormTranscriptSegment,
} from '@/lib/short-form';
import { cropFocusAt, reliableFaceCoverage, smoothFaceTrack } from '@/lib/short-form/crop';
import { shortLoudnessAnalysisArgs, shortRenderArgs } from '@/lib/short-form/render';
import { parseLoudnessMeasurement } from '@/lib/short-form/render-job';

function transcript(count = 24): ShortFormTranscriptSegment[] {
  return Array.from({ length: count }, (_, index) => {
    const start = index * 6;
    const text =
      index % 3 === 0
        ? `How do you solve problem number ${index}?`
        : `This practical step gives the complete answer ${index}.`;
    return {
      start,
      end: start + 5,
      text,
      words: text.split(' ').map((word, wordIndex) => ({
        start: start + wordIndex * 0.45,
        end: start + wordIndex * 0.45 + 0.35,
        text: word,
      })),
    };
  });
}

describe('short-form planning', () => {
  it('validates the five-to-ten, 15-to-45 second batch contract and vertical caption defaults', () => {
    const parsed = shortFormBatchConfigSchema.parse({});
    expect(parsed).toMatchObject({
      count: 8,
      minDurationSeconds: 15,
      maxDurationSeconds: 45,
      useAi: false,
    });
    expect(DEFAULT_SHORT_CAPTION_STYLE).toMatchObject({ maxWordsPerCue: 4, marginVertical: 280 });
    expect(shortFormBatchConfigSchema.safeParse({ count: 4 }).success).toBe(false);
    expect(shortFormBatchConfigSchema.safeParse({ count: 11 }).success).toBe(false);
    expect(
      shortFormBatchConfigSchema.safeParse({ minDurationSeconds: 30, maxDurationSeconds: 20 })
        .success
    ).toBe(false);
  });

  it('selects sentence-aligned, diverse candidates without more than 20% pairwise overlap', () => {
    const source = transcript();
    const result = planShortFormCandidates({
      transcript: source,
      config: shortFormBatchConfigSchema.parse({ count: 6 }),
    });
    expect(result.candidates).toHaveLength(6);
    const boundaries = sentenceBoundaries(source);
    for (const candidate of result.candidates) {
      expect(candidate.end - candidate.start).toBeGreaterThanOrEqual(15);
      expect(candidate.end - candidate.start).toBeLessThanOrEqual(45);
      expect(boundaries).toContain(candidate.start);
      expect(boundaries).toContain(candidate.end);
    }
    expect(boundaries.slice(0, 6).map((value) => Number(value.toFixed(2)))).toEqual([
      0, 3.05, 6, 9.5, 12, 15.5,
    ]);
    for (let left = 0; left < result.candidates.length; left += 1) {
      for (let right = left + 1; right < result.candidates.length; right += 1) {
        const a = result.candidates[left]!;
        const b = result.candidates[right]!;
        const overlap = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
        expect(overlap / Math.min(a.end - a.start, b.end - b.start)).toBeLessThanOrEqual(0.2);
      }
    }
  });

  it('uses lexical diversity, not only non-overlap, during MMR selection', () => {
    const proposal = (start: number, hook: string, total: number): ShortFormCandidatePlan => ({
      start,
      end: start + 20,
      title: hook,
      socialCaption: hook,
      hashtags: [],
      hook,
      rationale: 'test',
      scores: {
        hook: total,
        completeness: total,
        speechDensity: total,
        salience: total,
        visualStability: total,
        total,
      },
    });
    const strongest = proposal(0, 'five mistakes founders make', 0.9);
    const duplicateTopic = proposal(30, 'five mistakes founders make today', 0.89);
    const distinctTopic = proposal(60, 'how customer interviews reveal demand', 0.8);

    expect(selectDiverseCandidates([strongest, duplicateTopic, distinctTopic], 2)).toEqual([
      strongest,
      distinctTopic,
    ]);
  });

  it('returns fewer candidates with an explicit warning instead of padding weak duplicates', () => {
    const result = planShortFormCandidates({
      transcript: transcript(4),
      config: shortFormBatchConfigSchema.parse({ count: 10 }),
    });
    expect(result.candidates.length).toBeLessThan(10);
    expect(result.warnings[0]).toMatch(/Only .* qualified/);
  });

  it('snaps edited ranges to transcript sentence boundaries', () => {
    expect(snapShortRange(transcript(5), 0.2, 16.7)).toEqual({ start: 0, end: 15.5 });
    expect(snapShortRange([], 0, 20)).toBeNull();
    expect(transcriptTextForRange(transcript(3), 6, 15.5)).toBe(
      'This practical step gives the complete answer 1. This practical step gives the complete answer 2.'
    );
  });
});

describe('short-form crop tracking', () => {
  it('chooses mouth motion, applies a dead zone and bounds pan velocity', () => {
    const track = smoothFaceTrack([
      {
        time: 0,
        x: 0.1,
        y: 0.2,
        width: 0.2,
        height: 0.3,
        confidence: 0.9,
        mouthMotion: 0.1,
        scene: 0,
      },
      {
        time: 0,
        x: 0.6,
        y: 0.2,
        width: 0.15,
        height: 0.25,
        confidence: 0.9,
        mouthMotion: 0.8,
        scene: 0,
      },
      {
        time: 0.2,
        x: 0.1,
        y: 0.2,
        width: 0.2,
        height: 0.3,
        confidence: 0.9,
        mouthMotion: 0.9,
        scene: 0,
      },
    ]);
    expect(track[0]!.x).toBeCloseTo(0.675);
    expect(track[1]!.x).toBeCloseTo(0.605);
    expect(Math.abs(track[1]!.x - track[0]!.x)).toBeCloseTo(0.35 * 0.2);

    const held = smoothFaceTrack([
      { time: 0, x: 0.2, y: 0.2, width: 0.2, height: 0.2, confidence: 1, scene: 0 },
      { time: 0.2, x: 0.22, y: 0.21, width: 0.2, height: 0.2, confidence: 1, scene: 0 },
    ]);
    expect(held[1]!.x).toBeCloseTo(0.3);
    expect(held[1]!.y).toBeCloseTo(0.284);
  });

  it('resets at scene cuts and interpolates preview focus', () => {
    const track = smoothFaceTrack([
      { time: 0, x: 0, y: 0, width: 0.2, height: 0.2, confidence: 1, scene: 0 },
      { time: 0.2, x: 0.8, y: 0.8, width: 0.2, height: 0.2, confidence: 1, scene: 1 },
    ]);
    expect(track[1]!.x).toBeCloseTo(0.9);
    expect(
      cropFocusAt(
        [
          { time: 0, x: 0.2, y: 0.3, confidence: 1 },
          { time: 1, x: 0.6, y: 0.7, confidence: 0.8 },
        ],
        0.5
      )
    ).toMatchObject({ x: 0.4, y: 0.5, confidence: 0.8 });
    expect(cropFocusAt([], 1)).toBeNull();
  });

  it('uses mouth motion during speech and the largest face outside speech', () => {
    const samples = [
      { time: 1, x: 0.1, y: 0.1, width: 0.4, height: 0.4, confidence: 1, mouthMotion: 0.1 },
      { time: 1, x: 0.7, y: 0.1, width: 0.2, height: 0.2, confidence: 1, mouthMotion: 0.9 },
    ];
    expect(
      smoothFaceTrack(samples, { speechRanges: [{ start: 0.5, end: 1.5 }] })[0]!.x
    ).toBeCloseTo(0.8);
    expect(smoothFaceTrack(samples, { speechRanges: [{ start: 2, end: 3 }] })[0]!.x).toBeCloseTo(
      0.3
    );
  });

  it('falls back when reliable face evidence covers less than half the clip', () => {
    const evidence = [
      { start: 0, end: 4, confidence: 0.9 },
      { start: 4, end: 12, confidence: 0.2 },
    ];
    expect(reliableFaceCoverage(evidence, 0, 10)).toBeCloseTo(0.4);
    expect(reliableFaceCoverage(evidence, 0, 8, 0.1)).toBe(1);
  });
});

describe('short-form rendering', () => {
  it('builds a measured two-pass 1080x1920 H.264/AAC render capped at 60 fps', () => {
    const analysis = shortLoudnessAnalysisArgs('/tmp/in.mp4', 5, 30);
    expect(analysis[analysis.indexOf('-ss') + 1]).toBe('5.000');
    expect(analysis[analysis.indexOf('-t') + 1]).toBe('25.000');
    expect(analysis[analysis.indexOf('-af') + 1]).toBe(
      'loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json'
    );
    const args = shortRenderArgs({
      inputPath: '/tmp/in.mp4',
      outputPath: '/tmp/out.mp4',
      assPath: '/tmp/captions.ass',
      start: 5,
      end: 30,
      sourceWidth: 1920,
      sourceHeight: 1080,
      sourceFps: 120,
      cropMode: 'AUTO',
      cropTrack: [
        { time: 0, x: 0.4, y: 0.35 },
        { time: 10, x: 0.6, y: 0.45 },
      ],
      loudness: { inputI: -22, inputTp: -4, inputLra: 5, inputThresh: -32, targetOffset: 0.2 },
    });
    const videoFilter = args[args.indexOf('-vf') + 1]!;
    const audioFilter = args[args.indexOf('-af') + 1]!;
    expect(args[args.indexOf('-ss') + 1]).toBe('5.000');
    expect(args[args.indexOf('-t') + 1]).toBe('25.000');
    expect(videoFilter).toContain('scale=1080:1920');
    expect(videoFilter).toContain('(t-0.000)/10.000');
    expect(videoFilter).toContain('0.400000+0.200000*max');
    expect(videoFilter).toContain('0.350000+0.100000*max');
    expect(videoFilter).toContain('setsar=1');
    expect(videoFilter).toContain("ass='/tmp/captions.ass'");
    expect(audioFilter).toContain('loudnorm=I=-14:TP=-1.5:LRA=11');
    expect(audioFilter).toContain('measured_I=-22');
    expect(args).toContain('libx264');
    expect(args).toContain('aac');
    expect(args[args.indexOf('-pix_fmt') + 1]).toBe('yuv420p');
    expect(args[args.indexOf('-r') + 1]).toBe('60');
    expect(args).toContain('+faststart');
  });

  it('uses padded fit when no reliable face track exists and parses loudness JSON', () => {
    const args = shortRenderArgs({
      inputPath: 'in',
      outputPath: 'out',
      assPath: 'captions.ass',
      start: 0,
      end: 20,
      sourceWidth: 1920,
      sourceHeight: 1080,
      sourceFps: 30,
      cropMode: 'PADDED',
      loudness: { inputI: -20, inputTp: -2, inputLra: 4, inputThresh: -30, targetOffset: 0 },
    });
    expect(args[args.indexOf('-vf') + 1]).toContain('force_original_aspect_ratio=decrease');
    expect(
      parseLoudnessMeasurement(
        'noise\n{"input_i":"-20","input_tp":"-2","input_lra":"4","input_thresh":"-30","target_offset":"0"}'
      )
    ).toEqual({
      inputI: -20,
      inputTp: -2,
      inputLra: 4,
      inputThresh: -30,
      targetOffset: 0,
    });
  });
});
