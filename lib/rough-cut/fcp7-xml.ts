import { nominalFps, secondsToFrames, type FrameRate } from '../timecode';
import { exportMarkers, type ExportMarker } from './export-markers';
import type { CameraClip, RoughCutDecisionList } from './types';

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pathUrl(relative: string): string {
  const encoded = relative
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `file://localhost/${encoded}`;
}

export function fcp7Rate(rate: FrameRate): { timebase: number; ntsc: boolean } {
  if (rate.num === 30000 && rate.den === 1001) return { timebase: 30, ntsc: true };
  if (rate.num === 60000 && rate.den === 1001) return { timebase: 60, ntsc: true };
  if (rate.num === 24000 && rate.den === 1001) return { timebase: 24, ntsc: true };
  return { timebase: nominalFps(rate), ntsc: false };
}

function rateXml(rate: FrameRate): string {
  const converted = fcp7Rate(rate);
  return `<rate>
            <timebase>${converted.timebase}</timebase>
            <ntsc>${converted.ntsc ? 'TRUE' : 'FALSE'}</ntsc>
          </rate>`;
}

function fileXml(
  fileId: string,
  clip: RoughCutDecisionList['clips'][number],
  source: CameraClip | undefined,
  rate: FrameRate
): string {
  const duration = secondsToFrames(source?.durationSeconds ?? clip.durationSeconds, rate);
  return `<file id="${xmlEscape(fileId)}">
                    <name>${xmlEscape(clip.fileName)}</name>
                    <pathurl>${xmlEscape(pathUrl(clip.targetUrl))}</pathurl>
                    ${rateXml(rate)}
                    <duration>${duration}</duration>
                  </file>`;
}

function clipItemXml(options: {
  id: string;
  name: string;
  start: number;
  end: number;
  inPoint: number;
  outPoint: number;
  duration: number;
  fileXml: string;
  rate: FrameRate;
}): string {
  return `<clipitem id="${xmlEscape(options.id)}">
                <name>${xmlEscape(options.name)}</name>
                <enabled>TRUE</enabled>
                <duration>${options.duration}</duration>
                ${rateXml(options.rate)}
                <start>${options.start}</start>
                <end>${options.end}</end>
                <in>${options.inPoint}</in>
                <out>${options.outPoint}</out>
                ${options.fileXml}
              </clipitem>`;
}

/** A sequence marker; `out` is -1 for a point, as Premiere and Resolve write it. */
function markerXml(marker: ExportMarker, rate: FrameRate): string {
  const inFrames = secondsToFrames(marker.timelineSeconds, rate);
  const outFrames =
    marker.durationSeconds === null ? -1 : inFrames + secondsToFrames(marker.durationSeconds, rate);
  return `<marker>
      <comment>${xmlEscape(marker.comment)}</comment>
      <name>${xmlEscape(marker.title)}</name>
      <in>${inFrames}</in>
      <out>${outFrames}</out>
    </marker>`;
}

export type Fcp7BuildOptions = {
  name: string;
  decisions: RoughCutDecisionList;
  clips: CameraClip[];
  handleFrames: number;
  /** Also export the cut islands as a second marker set. Off by default. */
  includeCuts?: boolean;
};

export function buildFcp7Xml(options: Fcp7BuildOptions): string {
  const rate: FrameRate = {
    num: options.decisions.rate.num,
    den: options.decisions.rate.den,
    dropFrame: options.decisions.rate.dropFrame,
  };
  const clipsByVersion = new Map(options.clips.map((clip) => [clip.versionId, clip]));
  const fileXmlByVersion = new Map<string, string>();
  const declared = new Set<string>();

  const fileFor = (versionId: string): string => {
    const cached = fileXmlByVersion.get(versionId);
    if (cached) return cached;
    const clip = options.decisions.clips.find((entry) => entry.versionId === versionId);
    if (!clip) return '';
    const fileId = `file-${versionId}`;
    const xml = declared.has(versionId)
      ? `<file id="${xmlEscape(fileId)}"/>`
      : fileXml(fileId, clip, clipsByVersion.get(versionId), rate);
    declared.add(versionId);
    fileXmlByVersion.set(versionId, `<file id="${xmlEscape(fileId)}"/>`);
    return xml;
  };

  const programItems: string[] = [];
  options.decisions.edits.forEach((edit, index) => {
    const handle = Math.max(0, options.handleFrames);
    const inPoint = Math.max(0, secondsToFrames(edit.inSeconds, rate) - handle);
    const outPoint = secondsToFrames(edit.outSeconds, rate) + handle;
    const start = secondsToFrames(edit.timelineStartSeconds, rate);
    const end = secondsToFrames(edit.timelineEndSeconds, rate);
    const source = clipsByVersion.get(edit.sourceVersionId);
    const duration = secondsToFrames(source?.durationSeconds ?? edit.outSeconds, rate);
    programItems.push(
      clipItemXml({
        id: `clipitem-program-${index + 1}`,
        name: edit.cameraRole,
        start,
        end,
        inPoint,
        outPoint: Math.max(inPoint + 1, outPoint),
        duration,
        fileXml: fileFor(edit.sourceVersionId),
        rate,
      })
    );
  });

  const stackedTracks = [...options.decisions.clips]
    .sort((a, b) => a.track - b.track)
    .map((clip, index) => {
      const source = clipsByVersion.get(clip.versionId);
      const start = secondsToFrames(clip.offsetSeconds, rate);
      const duration = secondsToFrames(source?.durationSeconds ?? clip.durationSeconds, rate);
      const item = clipItemXml({
        id: `clipitem-stack-${index + 1}`,
        name: clip.role,
        start,
        end: start + duration,
        inPoint: 0,
        outPoint: duration,
        duration,
        fileXml: fileFor(clip.versionId),
        rate,
      });
      return `            <track>
              ${item}
            </track>`;
    });

  const markers = exportMarkers(options.decisions, { includeCuts: options.includeCuts ?? false })
    .map((marker) => markerXml(marker, rate))
    .join('\n    ');
  const markersXml = markers ? `\n    ${markers}` : '';

  const sequenceDuration = options.decisions.edits.reduce((max, edit) => {
    const end = secondsToFrames(edit.timelineEndSeconds, rate);
    return end > max ? end : max;
  }, 0);

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="5">
  <sequence id="sequence-1">
    <name>${xmlEscape(options.name)}</name>
    ${rateXml(rate)}
    <duration>${sequenceDuration}</duration>
    <timecode>
      ${rateXml(rate)}
      <string>00:00:00:00</string>
      <frame>0</frame>
      <displayformat>${rate.dropFrame ? 'DF' : 'NDF'}</displayformat>
    </timecode>
    <media>
      <video>
        <format>
          <samplecharacteristics>
            ${rateXml(rate)}
          </samplecharacteristics>
        </format>
        <track>
          ${programItems.join('\n              ')}
        </track>
${stackedTracks.join('\n')}
      </video>
    </media>${markersXml}
  </sequence>
</xmeml>
`;
}
