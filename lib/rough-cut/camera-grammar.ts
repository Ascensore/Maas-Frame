import { LOW_ATTRIBUTION_CONFIDENCE } from './attribute';
import type { AttributedTurn } from './types';

/**
 * The brief's camera grammar, applied to attributed turns before the
 * multicam decisions run. A held turn keeps its speaker and timing but is
 * moved to the wide camera and marked, so the decision carries the reason.
 */

export const CHAOS_WINDOW_SECONDS = 6;
export const CHAOS_MIN_SPEAKERS = 3;

export type CameraGrammarOptions = {
  wideVersionId: string;
  followSpeaker: boolean;
  holdWideOnChaos: boolean;
  windowSeconds?: number;
  minSpeakers?: number;
  lowConfidence?: number;
};

/**
 * Chaos: within a window starting at a turn, three or more distinct speakers
 * start a turn, or more than half of the turns were attributed with low
 * confidence. Every turn starting in such a window is held wide.
 */
export function chaoticTurnIndexes(
  turns: AttributedTurn[],
  options: { windowSeconds?: number; minSpeakers?: number; lowConfidence?: number } = {}
): Set<number> {
  const window = options.windowSeconds ?? CHAOS_WINDOW_SECONDS;
  const minSpeakers = options.minSpeakers ?? CHAOS_MIN_SPEAKERS;
  const lowConfidence = options.lowConfidence ?? LOW_ATTRIBUTION_CONFIDENCE;
  const ordered = turns
    .map((turn, index) => ({ turn, index }))
    .sort((a, b) => a.turn.start - b.turn.start);
  const held = new Set<number>();
  for (let anchor = 0; anchor < ordered.length; anchor += 1) {
    const from = ordered[anchor]!.turn.start;
    const inWindow: Array<{ turn: AttributedTurn; index: number }> = [];
    for (let cursor = anchor; cursor < ordered.length; cursor += 1) {
      const entry = ordered[cursor]!;
      if (entry.turn.start - from >= window) break;
      inWindow.push(entry);
    }
    const speakers = new Set(
      inWindow
        .map((entry) => entry.turn.speaker)
        .filter((speaker): speaker is string => speaker !== null)
    );
    const lowCount = inWindow.filter((entry) => entry.turn.confidence < lowConfidence).length;
    const chaotic = speakers.size >= minSpeakers || lowCount * 2 > inWindow.length;
    if (!chaotic) continue;
    for (const entry of inWindow) held.add(entry.index);
  }
  return held;
}

export function applyCameraGrammar(
  turns: AttributedTurn[],
  options: CameraGrammarOptions
): AttributedTurn[] {
  if (!options.followSpeaker) {
    return turns.map((turn) => ({ ...turn, versionId: options.wideVersionId, hold: 'primary' }));
  }
  if (!options.holdWideOnChaos) return turns.map((turn) => ({ ...turn }));
  const held = chaoticTurnIndexes(turns, options);
  return turns.map((turn, index) =>
    held.has(index) ? { ...turn, versionId: options.wideVersionId, hold: 'chaos' } : { ...turn }
  );
}
