import { z } from 'zod';
import type { FrameRate } from '../timecode';
import { assignStackedTracks } from './camera-roles';
import { buildRoughCutTargetUrl } from './media-paths';
import type { CameraClip, EditDecision, RoughCutDecisionList } from './types';

const editSchema = z.object({
  timelineStartSeconds: z.number().finite().nonnegative(),
  timelineEndSeconds: z.number().finite().nonnegative(),
  inSeconds: z.number().finite().nonnegative(),
  outSeconds: z.number().finite().nonnegative(),
  sourceVersionId: z.string().min(1),
  cameraRole: z.string().min(1),
  targetTrack: z.number().int().positive(),
});

const clipSchema = z.object({
  versionId: z.string().min(1),
  videoId: z.string().min(1),
  role: z.string().min(1),
  offsetSeconds: z.number().finite(),
  durationSeconds: z.number().finite().nonnegative(),
  track: z.number().int().positive(),
  fileName: z.string().min(1),
  targetUrl: z.string().min(1),
});

export const roughCutDecisionListSchema = z.object({
  version: z.literal(1),
  edits: z.array(editSchema),
  clips: z.array(clipSchema),
  rate: z.object({
    num: z.number().int().positive(),
    den: z.number().int().positive(),
    dropFrame: z.boolean(),
  }),
});

export function parseRoughCutDecisionList(value: unknown): RoughCutDecisionList | null {
  const parsed = roughCutDecisionListSchema.safeParse(value);
  if (!parsed.success) return null;
  return parsed.data;
}

export function assembleDecisionList(options: {
  edits: EditDecision[];
  clips: CameraClip[];
  fileNames: Map<string, string>;
  mediaPathPrefix: string;
  rate: FrameRate;
}): RoughCutDecisionList {
  const tracks = assignStackedTracks(options.clips);
  return {
    version: 1,
    edits: options.edits,
    clips: options.clips.map((clip) => {
      const fileName = options.fileNames.get(clip.versionId) ?? `${clip.role}.mp4`;
      return {
        versionId: clip.versionId,
        videoId: clip.videoId,
        role: clip.role,
        offsetSeconds: clip.offsetSeconds,
        durationSeconds: clip.durationSeconds,
        track: tracks.get(clip.versionId) ?? 2,
        fileName,
        targetUrl: buildRoughCutTargetUrl(options.mediaPathPrefix, fileName),
      };
    }),
    rate: {
      num: options.rate.num,
      den: options.rate.den,
      dropFrame: options.rate.dropFrame,
    },
  };
}
