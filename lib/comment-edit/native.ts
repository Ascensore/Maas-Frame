import type { TimelineEffect } from '@/lib/rough-cut/effects';
import type { RoughCutDecisionList } from '@/lib/rough-cut/types';
import { fcp7Rate } from '@/lib/rough-cut/fcp7-xml';

export type NativeMedia = {
  versionId: string;
  fileName: string;
  title: string;
  duration: number;
  frameRateNum?: number;
  frameRateDen?: number;
  downloadPath: string;
};
export type NativeEditPackage = {
  version: 1;
  id: string;
  name: string;
  xml: string;
  media: NativeMedia[];
  notes: string[];
  graphics: Array<
    Extract<TimelineEffect, { kind: 'graphic' }> & { startFrame: number; endFrame: number }
  >;
  frameRate: { num: number; den: number };
};
function xml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** A program-only sequence: source picture, source speech, B-roll, then graphic composites. */
export function buildNativeEditPackage(options: {
  id: string;
  name: string;
  decisions: RoughCutDecisionList;
  media: NativeMedia[];
  outputVersionId: string;
}): NativeEditPackage {
  const { decisions, media } = options;
  options = { ...options, name: `${options.name} [OpenFrame ${options.id}]` };
  const fps = decisions.rate.num / decisions.rate.den;
  const frames = (seconds: number) => Math.round(seconds * fps);
  const converted = fcp7Rate(decisions.rate);
  const rate = `<rate><timebase>${converted.timebase}</timebase><ntsc>${converted.ntsc ? 'TRUE' : 'FALSE'}</ntsc></rate>`;
  const duration = frames(decisions.edits.at(-1)?.timelineEndSeconds ?? 0);
  const sources = new Map(media.map((m) => [m.versionId, m]));
  let sequence = 0;
  const clip = (
    versionId: string,
    start: number,
    end: number,
    sourceIn: number,
    kind: 'video' | 'audio',
    channel = 1
  ) => {
    const source = sources.get(versionId);
    if (!source || !/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.test(source.fileName))
      throw new Error('Missing or invalid native edit media');
    const sourceFps =
      source.frameRateNum && source.frameRateDen ? source.frameRateNum / source.frameRateDen : fps;
    const sourceFrames = (seconds: number) => Math.round(seconds * sourceFps);
    const sourceRate = fcp7Rate({
      num: source.frameRateNum ?? decisions.rate.num,
      den: source.frameRateDen ?? decisions.rate.den,
      dropFrame: false,
    });
    const sourceRateXml = `<rate><timebase>${sourceRate.timebase}</timebase><ntsc>${sourceRate.ntsc ? 'TRUE' : 'FALSE'}</ntsc></rate>`;
    return `<clipitem id="item-${++sequence}"><name>${xml(source.title)}</name><enabled>TRUE</enabled>${sourceRateXml}<duration>${sourceFrames(source.duration)}</duration><start>${frames(start)}</start><end>${frames(end)}</end><in>${sourceFrames(sourceIn)}</in><out>${sourceFrames(sourceIn + end - start)}</out><file id="file-${xml(versionId)}"><name>${xml(source.fileName)}</name><pathurl>file://localhost/OPENFRAME_MEDIA/${source.fileName}</pathurl>${sourceRateXml}<duration>${sourceFrames(source.duration)}</duration><media><video/><audio><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics><channelcount>2</channelcount></audio></media></file><sourcetrack><mediatype>${kind}</mediatype><trackindex>${channel}</trackindex></sourcetrack></clipitem>`;
  };
  const program = (kind: 'video' | 'audio', channel = 1) =>
    decisions.edits
      .map((e) =>
        clip(
          kind === 'audio' ? options.outputVersionId : e.sourceVersionId,
          e.timelineStartSeconds,
          e.timelineEndSeconds,
          kind === 'audio' ? e.timelineStartSeconds : e.inSeconds,
          kind,
          channel
        )
      )
      .join('');
  const broll = (decisions.effects ?? [])
    .filter((e) => e.kind === 'broll')
    .map((e) => clip(e.sourceVersionId, e.start, e.end, e.sourceIn, 'video'))
    .join('');
  // Use the exact reviewed output for graphic sections. Their animation, text and brand
  // stay identical on both hosts; the remaining program and B-roll stay source-editable.
  const graphics = (decisions.effects ?? [])
    .filter((e) => e.kind === 'graphic')
    .map((e) => clip(options.outputVersionId, e.start, e.end, e.start, 'video'))
    .join('');
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="5"><sequence id="openframe-${xml(options.id)}"><name>${xml(options.name)}</name>${rate}<duration>${duration}</duration><timecode>${rate}<string>00:00:00:00</string><frame>0</frame><displayformat>${decisions.rate.dropFrame ? 'DF' : 'NDF'}</displayformat></timecode><media><video><format><samplecharacteristics>${rate}<width>1920</width><height>1080</height></samplecharacteristics></format><track>${program('video')}</track><track>${broll}</track><track>${graphics}</track></video><audio><numOutputChannels>2</numOutputChannels><format><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics></format><track>${program('audio', 1)}</track><track>${program('audio', 2)}</track></audio></media></sequence></xmeml>\n`;
  return {
    version: 1,
    id: options.id,
    name: options.name,
    xml: body,
    media,
    frameRate: { num: decisions.rate.num, den: decisions.rate.den },
    graphics: (decisions.effects ?? [])
      .filter((e) => e.kind === 'graphic')
      .map((e) => ({ ...e, startFrame: frames(e.start), endFrame: frames(e.end) })),
    notes: [
      'Imports as a new 1080p timeline. Original sequences are preserved.',
      'Speech uses the exact reviewed audio. Cuts and B-roll remain editable. Graphics are rendered composites of the reviewed draft; change their text/colors in OpenFrame and render again.',
      'Keep the downloaded media folder with this project.',
    ],
  };
}
