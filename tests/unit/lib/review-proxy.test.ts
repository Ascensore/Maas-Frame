import { describe, expect, it } from 'vitest';
import {
  needsReviewProxy,
  reviewProxyBurnInLabel,
  reviewProxyFfmpegArgs,
  shouldTranscodeReviewProxy,
} from '@/lib/review-proxy';
import {
  needsReviewProxy as workerNeedsReviewProxy,
  reviewProxyBurnInLabel as workerReviewProxyBurnInLabel,
  reviewProxyFfmpegArgs as workerReviewProxyFfmpegArgs,
  shouldTranscodeReviewProxy as workerShouldTranscodeReviewProxy,
} from '../../../worker/src/review-proxy';

const PLAYABLE = {
  videoCodec: 'h264',
  audioCodec: 'aac',
  formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
};

const PRORES = {
  videoCodec: 'prores',
  audioCodec: 'pcm_s24le',
  formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
};

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

  it('appends a drawtext burn-in when a label is supplied', () => {
    const args = reviewProxyFfmpegArgs('/tmp/in.bin', '/tmp/out.mp4', 'CONFIDENTIAL · Ada:Cam');
    const vf = args[args.indexOf('-vf') + 1];
    expect(vf).toContain(
      "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease"
    );
    expect(vf).toContain("drawtext=text='CONFIDENTIAL · Ada\\:Cam'");
    expect(vf).toContain('fontcolor=white@0.18');
  });
});

describe('reviewProxyBurnInLabel', () => {
  it('prefixes CONFIDENTIAL and trims the project name', () => {
    expect(reviewProxyBurnInLabel('  Dailies  ')).toBe('CONFIDENTIAL · Dailies');
  });

  it('falls back when the project name is empty', () => {
    expect(reviewProxyBurnInLabel('   ')).toBe('CONFIDENTIAL · Review');
  });
});

describe('shouldTranscodeReviewProxy', () => {
  it('still skips a browser-safe file when the project does not watermark', () => {
    expect(shouldTranscodeReviewProxy(PLAYABLE, { kind: 'VIDEO', watermarkReviews: false })).toBe(
      false
    );
  });

  it('transcodes a browser-safe file when the project watermarks reviews', () => {
    expect(shouldTranscodeReviewProxy(PLAYABLE, { kind: 'VIDEO', watermarkReviews: true })).toBe(
      true
    );
  });

  it('does not transcode IMAGE or PDF even when the project watermarks reviews', () => {
    expect(shouldTranscodeReviewProxy(PLAYABLE, { kind: 'IMAGE', watermarkReviews: true })).toBe(
      false
    );
    expect(shouldTranscodeReviewProxy(PRORES, { kind: 'PDF', watermarkReviews: true })).toBe(false);
  });

  it('still transcodes ProRes when watermarks are off', () => {
    expect(shouldTranscodeReviewProxy(PRORES, { kind: 'VIDEO', watermarkReviews: false })).toBe(
      true
    );
  });
});

describe('worker copy', () => {
  it('makes the same skip/transcode decision as the app module', () => {
    expect(workerNeedsReviewProxy(PRORES)).toBe(needsReviewProxy(PRORES));
    expect(
      workerShouldTranscodeReviewProxy(PLAYABLE, { kind: 'VIDEO', watermarkReviews: true })
    ).toBe(shouldTranscodeReviewProxy(PLAYABLE, { kind: 'VIDEO', watermarkReviews: true }));
    expect(workerReviewProxyBurnInLabel('Dailies')).toBe(reviewProxyBurnInLabel('Dailies'));
    expect(workerReviewProxyFfmpegArgs('/in', '/out')).toEqual(
      reviewProxyFfmpegArgs('/in', '/out')
    );
    expect(workerReviewProxyFfmpegArgs('/in', '/out', 'CONFIDENTIAL · Ada:Cam')).toEqual(
      reviewProxyFfmpegArgs('/in', '/out', 'CONFIDENTIAL · Ada:Cam')
    );
  });
});
