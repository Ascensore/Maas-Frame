import { describe, expect, it } from 'vitest';
import { assignStackedTracks, inferCameraRole, pickWideClip } from '@/lib/rough-cut/camera-roles';

describe('inferCameraRole', () => {
  it('reads the configured metadata key first', () => {
    expect(inferCameraRole('ignored.mp4', { camera: 'A' }, 'camera')).toBe('A');
    expect(inferCameraRole('ignored.mp4', { Camera: 'wide' }, 'camera')).toBe('WIDE');
  });

  it('falls back to a filename convention', () => {
    expect(inferCameraRole('Cam_B_interview.mov', {}, 'camera')).toBe('B');
    expect(inferCameraRole('camera-2.mp4', {}, 'camera')).toBe('2');
    expect(inferCameraRole('safety wide.mp4', {}, 'camera')).toBe('WIDE');
    expect(inferCameraRole('angle C ISO.mp4', {}, 'camera')).toBe('C');
  });

  it('returns CAM when nothing matches', () => {
    expect(inferCameraRole('clip-001.mp4', {}, 'camera')).toBe('CAM');
  });
});

describe('pickWideClip', () => {
  const clips = [
    { role: 'A', position: 1, videoId: 'va' },
    { role: 'WIDE', position: 0, videoId: 'vw' },
    { role: 'B', position: 2, videoId: 'vb' },
  ];

  it('picks the clip whose role matches the profile wide role', () => {
    const picked = pickWideClip(clips, 'WIDE');
    expect(picked).toEqual({ clip: clips[1], inferred: false });
  });

  it('falls back to the first clip by position when no wide exists', () => {
    const withoutWide = clips.filter((clip) => clip.role !== 'WIDE');
    const picked = pickWideClip(withoutWide, 'WIDE');
    expect(picked).toEqual({ clip: withoutWide[0], inferred: true });
  });

  it('returns null for an empty list', () => {
    expect(pickWideClip([], 'WIDE')).toBeNull();
  });
});

describe('assignStackedTracks', () => {
  it('puts WIDE on track 2 and the rest in alphabetical order after the program track', () => {
    const tracks = assignStackedTracks([
      { role: 'B', versionId: 'b' },
      { role: 'WIDE', versionId: 'w' },
      { role: 'A', versionId: 'a' },
    ]);
    expect(tracks.get('w')).toBe(2);
    expect(tracks.get('a')).toBe(3);
    expect(tracks.get('b')).toBe(4);
  });
});
