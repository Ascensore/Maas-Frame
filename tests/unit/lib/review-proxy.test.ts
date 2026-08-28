import { describe, expect, it } from 'vitest';
import { needsReviewProxy, reviewProxyFfmpegArgs } from '@/lib/review-proxy';
import {
  needsReviewProxy as workerNeedsReviewProxy,
  reviewProxyFfmpegArgs as workerReviewProxyFfmpegArgs,
} from '../../../worker/src/review-proxy';

describe('needsReviewProxy', () => {
  it('skips a browser-safe H.264 AAC MP4', () => {
    expect(
      needsReviewProxy({
        videoCodec: 'h264',
        audioCodec: 'aac',
        formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
      })
    ).toBe(false);
  });

  it('skips a silent H.264 MP4', () => {
    expect(
      needsReviewProxy({
        videoCodec: 'h264',
        audioCodec: null,
        formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
      })
    ).toBe(false);
  });

  it('requires a proxy for Apple ProRes', () => {
    expect(
      needsReviewProxy({
        videoCodec: 'prores',
        audioCodec: 'pcm_s24le',
        formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
      })
    ).toBe(true);
  });

  it('requires a proxy for HEVC', () => {
    expect(
      needsReviewProxy({
        videoCodec: 'hevc',
        audioCodec: 'aac',
        formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
      })
    ).toBe(true);
  });

  it('requires a proxy for DNxHR', () => {
    expect(
      needsReviewProxy({
        videoCodec: 'dnxhd',
        audioCodec: 'pcm_s24le',
        formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
      })
    ).toBe(true);
  });

  it('requires a proxy when H.264 is wrapped in Matroska', () => {
    expect(
      needsReviewProxy({
        videoCodec: 'h264',
        audioCodec: 'aac',
        formatName: 'matroska,webm',
      })
    ).toBe(true);
  });

  it('requires a proxy when the soundtrack is PCM', () => {
    expect(
      needsReviewProxy({
        videoCodec: 'h264',
        audioCodec: 'pcm_s16le',
        formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
      })
    ).toBe(true);
  });
});

describe('reviewProxyFfmpegArgs', () => {
  it('asks ffmpeg for an H.264 AAC MP4 capped at 1080p', () => {
    expect(reviewProxyFfmpegArgs('/tmp/in.bin', '/tmp/out.mp4')).toEqual([
      '-y',
      '-i',
      '/tmp/in.bin',
      '-map',
      '0:v:0',
      '-map',
      '0:a:0?',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '20',
      '-pix_fmt',
      'yuv420p',
      '-vf',
      "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2",
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-ac',
      '2',
      '-movflags',
      '+faststart',
      '/tmp/out.mp4',
    ]);
  });
});

describe('worker copy', () => {
  it('makes the same skip/transcode decision as the app module', () => {
    const probe = {
      videoCodec: 'prores',
      audioCodec: 'pcm_s24le',
      formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
    };
    expect(workerNeedsReviewProxy(probe)).toBe(needsReviewProxy(probe));
    expect(workerReviewProxyFfmpegArgs('/in', '/out')).toEqual(
      reviewProxyFfmpegArgs('/in', '/out')
    );
  });
});
