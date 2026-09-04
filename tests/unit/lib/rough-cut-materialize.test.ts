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

    const firstInput = args.indexOf('/tmp/a.mp4');
    const firstSs = args.indexOf('-ss');
    const firstDashI = args.indexOf('-i');
    expect(firstSs).toBeGreaterThan(-1);
    expect(firstDashI).toBeGreaterThan(firstSs);
    expect(firstInput).toBe(firstDashI + 1);
    expect(args[firstSs + 1]).toBe('1.500');

    expect(args).toContain('-filter_complex');
    expect(args).toContain('[0:v:0][0:a:0][1:v:0][1:a:0]concat=n=2:v=1:a=1[vout][aout]');
    expect(args).toContain('libx264');
    expect(args).toContain('aac');
    expect(args[args.length - 1]).toBe('/tmp/out.mp4');
  });

  it('refuses an empty edit list', () => {
    expect(() => materializeFfmpegArgs([], '/tmp/out.mp4')).toThrow(/at least one edit/);
  });
});
