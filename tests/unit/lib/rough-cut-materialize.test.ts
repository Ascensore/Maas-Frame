import { describe, expect, it } from 'vitest';
import { materializeFfmpegArgs } from '@/lib/rough-cut/materialize';

describe('materializeFfmpegArgs', () => {
  it('seeks each source before -i and concatenates onto H.264 AAC', () => {
    const args = materializeFfmpegArgs(
      [
        { inputPath: '/tmp/a.mp4', inSeconds: 1.5, outSeconds: 4 },
        { inputPath: '/tmp/b.mp4', inSeconds: 0, outSeconds: 2.25 },
      ],
      '/tmp/out.mp4'
    );

    const firstSs = args.indexOf('-ss');
    const secondSs = args.indexOf('-ss', firstSs + 1);
    const firstDashI = args.indexOf('-i');
    const secondDashI = args.indexOf('-i', firstDashI + 1);
    expect(firstSs).toBeGreaterThan(-1);
    expect(secondSs).toBeGreaterThan(firstSs);
    expect(firstDashI).toBeGreaterThan(firstSs);
    expect(secondDashI).toBeGreaterThan(secondSs);
    expect(args[firstDashI + 1]).toBe('/tmp/a.mp4');
    expect(args[secondDashI + 1]).toBe('/tmp/b.mp4');
    expect(args[firstSs + 1]).toBe('1.500');
    expect(args[args.indexOf('-t') + 1]).toBe('2.500');
    expect(args[secondSs + 1]).toBe('0.000');
    expect(args[args.indexOf('-t', firstDashI) + 1]).toBe('2.250');

    expect(args).toContain('-filter_complex');
    const filter = args[args.indexOf('-filter_complex') + 1]!;
    expect(filter).toContain('[0:a:0]afade=t=in:st=0:d=0.005');
    expect(filter).toContain('afade=t=out:st=2.495:d=0.005[a0]');
    expect(filter).toContain('[1:a:0]afade=t=in:st=0:d=0.005');
    expect(filter).toContain('afade=t=out:st=2.245:d=0.005[a1]');
    expect(filter).toContain('[0:v:0][a0][1:v:0][a1]concat=n=2:v=1:a=1[vout][aout]');
    expect(args).toContain('libx264');
    expect(args).toContain('aac');
    expect(args[args.length - 1]).toBe('/tmp/out.mp4');
  });

  it('refuses an empty edit list', () => {
    expect(() => materializeFfmpegArgs([], '/tmp/out.mp4')).toThrow(/at least one edit/);
  });
});
