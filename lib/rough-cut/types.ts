export const ROUGH_CUT_OVERLAP = ['WIDE', 'HOLD', 'SPEAKER'] as const;
export const ROUGH_CUT_SYNC = ['AUTO', 'TIMECODE', 'WAVEFORM'] as const;
export const ROUGH_CUT_LAYOUTS = ['MULTICAM', 'SEQUENTIAL', 'LINEAR'] as const;

export type RoughCutOverlapBehaviour = (typeof ROUGH_CUT_OVERLAP)[number];
export type RoughCutSyncStrategy = (typeof ROUGH_CUT_SYNC)[number];
export type RoughCutLayout = (typeof ROUGH_CUT_LAYOUTS)[number];

export type ResolvedRoughCutProfile = {
  id: string | null;
  name: string;
  minShotSeconds: number;
  safetyPauseSeconds: number;
  maxShotSeconds: number | null;
  overlapBehaviour: RoughCutOverlapBehaviour;
  handleFrames: number;
  wideCameraRole: string;
  cameraRoleMetadataKey: string;
  syncStrategy: RoughCutSyncStrategy;
  mediaPathPrefix: string;
  isDefault: boolean;
};

export type CameraClip = {
  videoId: string;
  versionId: string;
  title: string;
  role: string;
  position: number;
  offsetSeconds: number;
  durationSeconds: number;
  frameRateNum: number;
  frameRateDen: number;
  dropFrame: boolean;
  startTimecode: string | null;
  recordedAt?: string | null;
  createdAt?: string | null;
  originalUrl: string;
  versionNumber: number;
  versionLabel: string | null;
};

export type AttributedTurn = {
  start: number;
  end: number;
  versionId: string;
  speaker: string | null;
  confidence: number;
};

export type EditDecision = {
  timelineStartSeconds: number;
  timelineEndSeconds: number;
  inSeconds: number;
  outSeconds: number;
  sourceVersionId: string;
  cameraRole: string;
  targetTrack: number;
};

export type RoughCutDecisionList = {
  version: 1;
  edits: EditDecision[];
  clips: Array<{
    versionId: string;
    videoId: string;
    role: string;
    offsetSeconds: number;
    durationSeconds: number;
    track: number;
    fileName: string;
    targetUrl: string;
  }>;
  rate: {
    num: number;
    den: number;
    dropFrame: boolean;
  };
};

export type RoughCutWarning = {
  code: string;
  message: string;
};

export type SyncReport = {
  strategy: RoughCutSyncStrategy | 'MIXED';
  clips: Array<{
    versionId: string;
    offsetSeconds: number;
    method: 'timecode' | 'waveform' | 'none' | 'sequence';
    confidence: number;
  }>;
};
