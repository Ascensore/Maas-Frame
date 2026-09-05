export type FaceSample = {
  time: number;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
  mouthMotion?: number;
  scene?: number;
};

export type CropPoint = { time: number; x: number; y: number; confidence: number };

export function reliableFaceCoverage(
  ranges: Array<{ start: number; end: number; confidence: number }>,
  start: number,
  end: number,
  minConfidence = 0.35
): number {
  const duration = Math.max(0, end - start);
  if (duration === 0) return 0;
  const covered = ranges.reduce((total, range) => {
    if (range.confidence < minConfidence) return total;
    return total + Math.max(0, Math.min(end, range.end) - Math.max(start, range.start));
  }, 0);
  return Math.max(0, Math.min(1, covered / duration));
}

export function smoothFaceTrack(
  samples: FaceSample[],
  options: {
    deadZone?: number;
    maxVelocity?: number;
    holdSeconds?: number;
    speechRanges?: Array<{ start: number; end: number }>;
  } = {}
): CropPoint[] {
  const deadZone = options.deadZone ?? 0.04;
  const maxVelocity = options.maxVelocity ?? 0.35;
  const holdSeconds = options.holdSeconds ?? 0.5;
  const grouped = new Map<string, FaceSample[]>();
  for (const sample of samples.filter((entry) => entry.confidence >= 0.35)) {
    const key = `${sample.scene ?? 0}:${sample.time.toFixed(3)}`;
    const list = grouped.get(key) ?? [];
    list.push(sample);
    grouped.set(key, list);
  }
  const chosen = [...grouped.values()]
    .map((faces) => {
      const duringSpeech =
        !options.speechRanges ||
        options.speechRanges.some(
          (range) => range.start <= faces[0]!.time && faces[0]!.time <= range.end
        );
      return [...faces].sort(
        (a, b) =>
          (duringSpeech ? (b.mouthMotion ?? 0) - (a.mouthMotion ?? 0) : 0) ||
          b.width * b.height - a.width * a.height
      )[0]!;
    })
    .sort((a, b) => a.time - b.time);
  const result: CropPoint[] = [];
  for (const face of chosen) {
    const targetX = Math.max(0, Math.min(1, face.x + face.width / 2));
    const targetY = Math.max(0, Math.min(1, face.y + face.height * 0.42));
    const previous = result[result.length - 1];
    if (
      !previous ||
      face.scene !== chosen[result.length - 1]?.scene ||
      face.time - previous.time > holdSeconds
    ) {
      result.push({ time: face.time, x: targetX, y: targetY, confidence: face.confidence });
      continue;
    }
    const elapsed = Math.max(0.001, face.time - previous.time);
    const move = (current: number, target: number) => {
      const delta = target - current;
      if (Math.abs(delta) <= deadZone) return current;
      return current + Math.sign(delta) * Math.min(Math.abs(delta), maxVelocity * elapsed);
    };
    result.push({
      time: face.time,
      x: move(previous.x, targetX),
      y: move(previous.y, targetY),
      confidence: face.confidence,
    });
  }
  return result;
}

export function cropFocusAt(track: CropPoint[], time: number): CropPoint | null {
  if (track.length === 0) return null;
  const nextIndex = track.findIndex((point) => point.time >= time);
  if (nextIndex <= 0) return track[Math.max(0, nextIndex)] ?? track[track.length - 1]!;
  const left = track[nextIndex - 1]!;
  const right = track[nextIndex]!;
  const fraction = (time - left.time) / Math.max(0.001, right.time - left.time);
  return {
    time,
    x: left.x + (right.x - left.x) * fraction,
    y: left.y + (right.y - left.y) * fraction,
    confidence: Math.min(left.confidence, right.confidence),
  };
}
