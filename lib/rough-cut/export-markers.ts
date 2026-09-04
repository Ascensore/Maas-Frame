import { cutMarkerPoint } from './markers';
import type { RoughCutDecisionList } from './types';

/**
 * The marker list an exporter writes: the program's placeholder markers,
 * plus, only on request, each cut island as a point marker where the
 * removed range used to be. Shared by the OTIO and FCP7 XML writers so both
 * carry the same set.
 */

export type ExportMarker = {
  key: string;
  kind: 'INFOGRAPHIC' | 'BROLL' | 'CUT';
  timelineSeconds: number;
  durationSeconds: number | null;
  title: string;
  comment: string;
  reason: { code: string; summary: string };
};

export function exportMarkers(
  decisions: RoughCutDecisionList,
  options: { includeCuts: boolean }
): ExportMarker[] {
  const out: ExportMarker[] = (decisions.markers ?? []).map((marker) => ({
    key: marker.key,
    kind: marker.kind,
    timelineSeconds: marker.timelineSeconds,
    durationSeconds: marker.durationSeconds,
    title: marker.title,
    comment: marker.reason.summary,
    reason: marker.reason,
  }));
  if (options.includeCuts) {
    const offsetByVersion = new Map(
      decisions.clips.map((clip) => [clip.versionId, clip.offsetSeconds])
    );
    const offsetOf = (versionId: string) => offsetByVersion.get(versionId) ?? 0;
    for (const cut of decisions.cuts ?? []) {
      const at = cutMarkerPoint(cut, decisions.edits, offsetOf);
      if (at === null) continue;
      out.push({
        key: cut.key,
        kind: 'CUT',
        timelineSeconds: at,
        durationSeconds: null,
        title: `Cut: ${cut.reason.summary}`,
        comment: cut.transcriptText ?? cut.reason.summary,
        reason: cut.reason,
      });
    }
  }
  // Same point: placeholders before the cut that precedes them, by kind name.
  return out.sort((a, b) => a.timelineSeconds - b.timelineSeconds || a.kind.localeCompare(b.kind));
}
