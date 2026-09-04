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
  /** Set by the camera grammar when the turn was moved to the wide camera on purpose. */
  hold?: 'chaos' | 'primary';
};

export const EDIT_REASON_CODES = [
  'SPEAKER_SWITCH',
  'HOLD_WIDE',
  'HOLD',
  'MAX_SHOT',
  'KEPT',
] as const;
export type EditReasonCode = (typeof EDIT_REASON_CODES)[number];

export type EditReason = { code: EditReasonCode; summary: string };

export type EditDecision = {
  timelineStartSeconds: number;
  timelineEndSeconds: number;
  inSeconds: number;
  outSeconds: number;
  sourceVersionId: string;
  cameraRole: string;
  targetTrack: number;
  /** Why this range is in the program. Absent on runs made before reasons existed. */
  reason?: EditReason;
};

export const CUT_REASON_CODES = ['DEAD_AIR', 'FALSE_START', 'REJECTED_TAKE'] as const;
export type CutReasonCode = (typeof CUT_REASON_CODES)[number];

/** A removed source range and why, keyed so overrides survive a regenerate. */
export type CutIsland = {
  key: string;
  sourceVersionId: string;
  inSeconds: number;
  outSeconds: number;
  reason: { code: CutReasonCode; summary: string };
  transcriptText: string | null;
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
  /** Only actual removals. Absent on runs made before the editorial pass existed. */
  cuts?: CutIsland[];
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
