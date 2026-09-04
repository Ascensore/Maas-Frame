import { framesToSeconds, secondsToFrames, type FrameRate } from '../timecode';
import { exportMarkers, type ExportMarker } from './export-markers';
import type { CameraClip, EditDecision, RoughCutDecisionList } from './types';

export type OtioRationalTime = {
  OTIO_SCHEMA: 'RationalTime.1';
  value: number;
  rate: number;
};

export type OtioTimeRange = {
  OTIO_SCHEMA: 'TimeRange.1';
  start_time: OtioRationalTime;
  duration: OtioRationalTime;
};

export type OtioExternalReference = {
  OTIO_SCHEMA: 'ExternalReference.1';
  target_url: string;
  available_range: OtioTimeRange;
};

export type OtioClip = {
  OTIO_SCHEMA: 'Clip.1';
  name: string;
  source_range: OtioTimeRange;
  media_reference: OtioExternalReference;
};

export type OtioGap = {
  OTIO_SCHEMA: 'Gap.1';
  name: string;
  source_range: OtioTimeRange;
};

export type OtioMarker = {
  OTIO_SCHEMA: 'Marker.2';
  name: string;
  color: string;
  marked_range: OtioTimeRange;
  comment: string;
  metadata: {
    openframe: { key: string; kind: string; reason: { code: string; summary: string } };
  };
};

export type OtioTrack = {
  OTIO_SCHEMA: 'Track.1';
  name: string;
  kind: 'Video' | 'Audio';
  children: Array<OtioClip | OtioGap>;
  /** Only present when the program carries markers, so older exports are unchanged. */
  markers?: OtioMarker[];
};

export type OtioTimeline = {
  OTIO_SCHEMA: 'Timeline.1';
  name: string;
  global_start_time: OtioRationalTime;
  tracks: {
    OTIO_SCHEMA: 'Stack.1';
    name: string;
    children: OtioTrack[];
  };
};

function rateNumber(rate: FrameRate): number {
  return rate.num / rate.den;
}

function rationalTime(frames: number, rate: FrameRate): OtioRationalTime {
  return {
    OTIO_SCHEMA: 'RationalTime.1',
    value: frames,
    rate: rateNumber(rate),
  };
}

function timeRange(startFrames: number, durationFrames: number, rate: FrameRate): OtioTimeRange {
  return {
    OTIO_SCHEMA: 'TimeRange.1',
    start_time: rationalTime(startFrames, rate),
    duration: rationalTime(Math.max(0, durationFrames), rate),
  };
}

function handleSeconds(handleFrames: number, rate: FrameRate): number {
  if (handleFrames <= 0) return 0;
  return framesToSeconds(handleFrames, rate);
}

function clipChild(
  name: string,
  targetUrl: string,
  availableDurationSeconds: number,
  sourceInSeconds: number,
  sourceOutSeconds: number,
  rate: FrameRate,
  handleFrames: number
): OtioClip {
  const handles = handleSeconds(handleFrames, rate);
  const availableFrames = secondsToFrames(availableDurationSeconds, rate);
  const inFrames = Math.max(0, secondsToFrames(Math.max(0, sourceInSeconds - handles), rate));
  const outFrames = Math.min(availableFrames, secondsToFrames(sourceOutSeconds + handles, rate));
  const durationFrames = Math.max(1, outFrames - inFrames);
  return {
    OTIO_SCHEMA: 'Clip.1',
    name,
    source_range: timeRange(inFrames, durationFrames, rate),
    media_reference: {
      OTIO_SCHEMA: 'ExternalReference.1',
      target_url: targetUrl,
      available_range: timeRange(0, availableFrames, rate),
    },
  };
}

function gapChild(durationSeconds: number, rate: FrameRate): OtioGap {
  return {
    OTIO_SCHEMA: 'Gap.1',
    name: 'Gap',
    source_range: timeRange(0, Math.max(0, secondsToFrames(durationSeconds, rate)), rate),
  };
}

const MARKER_COLORS: Record<ExportMarker['kind'], string> = {
  INFOGRAPHIC: 'BLUE',
  BROLL: 'GREEN',
  CUT: 'RED',
};

function markerChild(marker: ExportMarker, rate: FrameRate): OtioMarker {
  const startFrames = secondsToFrames(marker.timelineSeconds, rate);
  const durationFrames =
    marker.durationSeconds === null ? 0 : secondsToFrames(marker.durationSeconds, rate);
  return {
    OTIO_SCHEMA: 'Marker.2',
    name: marker.title,
    color: MARKER_COLORS[marker.kind],
    marked_range: timeRange(startFrames, durationFrames, rate),
    comment: marker.comment,
    metadata: {
      openframe: { key: marker.key, kind: marker.kind, reason: marker.reason },
    },
  };
}

function programTrack(
  decisions: RoughCutDecisionList,
  clipsByVersion: Map<string, CameraClip>,
  rate: FrameRate,
  handleFrames: number,
  includeCuts: boolean
): OtioTrack {
  const children: Array<OtioClip | OtioGap> = [];
  let cursor = 0;
  for (const edit of decisions.edits) {
    if (edit.timelineStartSeconds > cursor + 1e-6) {
      children.push(gapChild(edit.timelineStartSeconds - cursor, rate));
    }
    const clip = clipsByVersion.get(edit.sourceVersionId);
    const fileName =
      decisions.clips.find((entry) => entry.versionId === edit.sourceVersionId)?.fileName ??
      edit.cameraRole;
    const targetUrl =
      decisions.clips.find((entry) => entry.versionId === edit.sourceVersionId)?.targetUrl ??
      fileName;
    children.push(
      clipChild(
        edit.cameraRole,
        targetUrl,
        clip?.durationSeconds ?? edit.outSeconds,
        edit.inSeconds,
        edit.outSeconds,
        rate,
        handleFrames
      )
    );
    cursor = edit.timelineEndSeconds;
    void fileName;
  }
  const markers = exportMarkers(decisions, { includeCuts }).map((marker) =>
    markerChild(marker, rate)
  );
  return {
    OTIO_SCHEMA: 'Track.1',
    name: 'Program',
    kind: 'Video',
    children,
    ...(markers.length > 0 ? { markers } : {}),
  };
}

function stackedTrack(
  clip: RoughCutDecisionList['clips'][number],
  source: CameraClip | undefined,
  rate: FrameRate,
  handleFrames: number
): OtioTrack {
  const children: Array<OtioClip | OtioGap> = [];
  if (clip.offsetSeconds > 1e-6) {
    children.push(gapChild(clip.offsetSeconds, rate));
  }
  children.push(
    clipChild(
      clip.role,
      clip.targetUrl,
      source?.durationSeconds ?? clip.durationSeconds,
      0,
      source?.durationSeconds ?? clip.durationSeconds,
      rate,
      handleFrames
    )
  );
  return {
    OTIO_SCHEMA: 'Track.1',
    name: clip.role,
    kind: 'Video',
    children,
  };
}

export type OtioBuildOptions = {
  name: string;
  decisions: RoughCutDecisionList;
  clips: CameraClip[];
  handleFrames: number;
  /** Also export the cut islands as a second marker set. Off by default. */
  includeCuts?: boolean;
};

export function buildOtioTimeline(options: OtioBuildOptions): OtioTimeline {
  const rate: FrameRate = {
    num: options.decisions.rate.num,
    den: options.decisions.rate.den,
    dropFrame: options.decisions.rate.dropFrame,
  };
  const clipsByVersion = new Map(options.clips.map((clip) => [clip.versionId, clip]));
  const stacked = [...options.decisions.clips].sort((a, b) => a.track - b.track);
  const tracks: OtioTrack[] = [
    programTrack(
      options.decisions,
      clipsByVersion,
      rate,
      options.handleFrames,
      options.includeCuts ?? false
    ),
    ...stacked.map((clip) =>
      stackedTrack(clip, clipsByVersion.get(clip.versionId), rate, options.handleFrames)
    ),
  ];
  return {
    OTIO_SCHEMA: 'Timeline.1',
    name: options.name,
    global_start_time: rationalTime(0, rate),
    tracks: {
      OTIO_SCHEMA: 'Stack.1',
      name: 'tracks',
      children: tracks,
    },
  };
}

export function serializeOtioTimeline(timeline: OtioTimeline): string {
  return `${JSON.stringify(timeline, null, 2)}\n`;
}

export function buildOtioFile(options: OtioBuildOptions): string {
  return serializeOtioTimeline(buildOtioTimeline(options));
}

export type { EditDecision };
