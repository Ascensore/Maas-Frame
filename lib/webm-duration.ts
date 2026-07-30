/**
 * MediaRecorder writes WebM in live mode: the Segment header carries an unknown
 * size and the Info block has no Duration, so nothing downstream can tell how
 * long a recording is. Browsers report `Infinity` for `audio.duration`, and
 * desktop players (mpv, VLC) keep playing past the end of a seek bar they never
 * got a length for.
 *
 * Live-mode output also has no SeekHead and no Cues, which means no stored byte
 * offsets, which means we can splice a Duration element into Info without
 * invalidating anything. If a file does carry a SeekHead we leave it alone: a
 * missing duration is better than shifted seek positions.
 */

const ID_SEGMENT = 0x18538067;
const ID_SEEK_HEAD = 0x114d9b74;
const ID_INFO = 0x1549a966;
const ID_TIMECODE_SCALE = 0x2ad7b1;
const ID_DURATION = 0x4489;

const DEFAULT_TIMECODE_SCALE = 1_000_000; // nanoseconds per tick, i.e. 1ms

type EbmlElement = {
  id: number;
  sizePos: number;
  sizeLength: number;
  contentStart: number;
  contentEnd: number;
  unknownSize: boolean;
};

// An EBML variable-length integer encodes its own width in the leading bits:
// 1xxxxxxx is one byte, 01xxxxxx two, and so on down to eight.
function vintLength(firstByte: number): number {
  for (let i = 0; i < 8; i++) {
    if (firstByte & (0x80 >> i)) return i + 1;
  }
  return 0;
}

function readSize(bytes: Uint8Array, pos: number): { value: number; length: number } | null {
  const length = vintLength(bytes[pos]);
  if (length === 0 || pos + length > bytes.length) return null;
  let value = bytes[pos] & (0xff >> length);
  for (let i = 1; i < length; i++) value = value * 0x100 + bytes[pos + i];
  return { value, length };
}

function isUnknownSize(value: number, length: number): boolean {
  return value === Math.pow(2, 7 * length) - 1;
}

function readElement(bytes: Uint8Array, pos: number, end: number): EbmlElement | null {
  if (pos >= end) return null;
  const idLength = vintLength(bytes[pos]);
  if (idLength === 0 || idLength > 4 || pos + idLength > end) return null;

  let id = 0;
  for (let i = 0; i < idLength; i++) id = id * 0x100 + bytes[pos + i];

  const sizePos = pos + idLength;
  const size = readSize(bytes, sizePos);
  if (!size) return null;

  const contentStart = sizePos + size.length;
  const unknownSize = isUnknownSize(size.value, size.length);
  const contentEnd = unknownSize ? end : contentStart + size.value;
  if (contentEnd > end) return null;

  return { id, sizePos, sizeLength: size.length, contentStart, contentEnd, unknownSize };
}

function findChild(
  bytes: Uint8Array,
  start: number,
  end: number,
  wantedId: number
): EbmlElement | null {
  let pos = start;
  while (pos < end) {
    const element = readElement(bytes, pos, end);
    if (!element) return null;
    if (element.id === wantedId) return element;
    if (element.unknownSize) return null;
    pos = element.contentEnd;
  }
  return null;
}

function readUnsigned(bytes: Uint8Array, element: EbmlElement): number | null {
  const length = element.contentEnd - element.contentStart;
  if (length < 1 || length > 8) return null;
  let value = 0;
  for (let i = 0; i < length; i++) value = value * 0x100 + bytes[element.contentStart + i];
  return value;
}

function minVintLength(value: number): number {
  for (let length = 1; length <= 8; length++) {
    if (value < Math.pow(2, 7 * length) - 1) return length;
  }
  return 0;
}

function writeVint(target: Uint8Array, pos: number, value: number, length: number): void {
  let rest = value;
  for (let i = length - 1; i >= 0; i--) {
    target[pos + i] = rest % 0x100;
    rest = Math.floor(rest / 0x100);
  }
  target[pos] |= 0x80 >> (length - 1);
}

/**
 * Returns a copy of `source` with Segment > Info > Duration set to `durationMs`,
 * or null when the file is not shaped the way MediaRecorder writes it.
 */
export function injectWebmDuration(source: Uint8Array, durationMs: number): Uint8Array | null {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return null;

  const segment = findChild(source, 0, source.length, ID_SEGMENT);
  if (!segment) return null;

  const segmentEnd = segment.contentEnd;
  const info = findChild(source, segment.contentStart, segmentEnd, ID_INFO);
  if (!info || info.unknownSize) return null;

  const scaleElement = findChild(source, info.contentStart, info.contentEnd, ID_TIMECODE_SCALE);
  const timecodeScale = scaleElement ? readUnsigned(source, scaleElement) : DEFAULT_TIMECODE_SCALE;
  if (!timecodeScale) return null;

  // Duration is expressed in timecode ticks, not milliseconds.
  const scaledDuration = (durationMs * 1_000_000) / timecodeScale;

  // Firefox reserves a Duration of 0 it never gets to fill in, which is the easy
  // case: overwriting it in place moves no bytes, so any SeekHead stays valid.
  const existing = findChild(source, info.contentStart, info.contentEnd, ID_DURATION);
  if (existing) {
    const width = existing.contentEnd - existing.contentStart;
    if (width !== 4 && width !== 8) return null;
    const out = source.slice();
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    if (width === 4) view.setFloat32(existing.contentStart, scaledDuration);
    else view.setFloat64(existing.contentStart, scaledDuration);
    return out;
  }

  // Chrome reserves nothing, so the element has to be spliced in and everything
  // after Info shifts. A SeekHead with entries in it stores those positions, and
  // rewriting them is more than this is worth: leave the file as it was instead.
  const seekHead = findChild(source, segment.contentStart, segmentEnd, ID_SEEK_HEAD);
  if (seekHead && seekHead.contentEnd > seekHead.contentStart) return null;

  // Duration element: 2-byte id, 1-byte size, 8-byte float.
  const DURATION_ELEMENT_SIZE = 11;
  const oldInfoSize = info.contentEnd - info.contentStart;
  const newInfoSize = oldInfoSize + DURATION_ELEMENT_SIZE;
  const newInfoSizeLength = Math.max(minVintLength(newInfoSize), info.sizeLength);
  if (newInfoSizeLength === 0) return null;

  const delta = DURATION_ELEMENT_SIZE + (newInfoSizeLength - info.sizeLength);
  const out = new Uint8Array(source.length + delta);

  out.set(source.subarray(0, info.sizePos), 0);
  writeVint(out, info.sizePos, newInfoSize, newInfoSizeLength);

  const newContentStart = info.sizePos + newInfoSizeLength;
  out.set(source.subarray(info.contentStart, info.contentEnd), newContentStart);

  const durationPos = newContentStart + oldInfoSize;
  out[durationPos] = 0x44;
  out[durationPos + 1] = 0x89;
  out[durationPos + 2] = 0x88; // 8 data bytes
  new DataView(out.buffer, out.byteOffset, out.byteLength).setFloat64(
    durationPos + 3,
    scaledDuration
  );

  out.set(source.subarray(info.contentEnd), durationPos + DURATION_ELEMENT_SIZE);

  // A live-mode Segment has an unknown size and needs no fixup; a sized one does.
  if (!segment.unknownSize) {
    const newSegmentSize = segmentEnd - segment.contentStart + delta;
    if (minVintLength(newSegmentSize) > segment.sizeLength) return null;
    out.fill(0, segment.sizePos, segment.sizePos + segment.sizeLength);
    writeVint(out, segment.sizePos, newSegmentSize, segment.sizeLength);
  }

  return out;
}

/**
 * Stamps a recorded duration into a WebM blob. Non-WebM blobs (Safari records
 * MP4, which already carries its duration) and unexpected layouts pass through
 * untouched, so callers can apply this unconditionally.
 */
export async function withWebmDuration(blob: Blob, durationMs: number): Promise<Blob> {
  if (!blob.type.toLowerCase().includes('webm')) return blob;
  try {
    const source = new Uint8Array(await blob.arrayBuffer());
    const patched = injectWebmDuration(source, durationMs);
    // The patched array owns its buffer outright, so handing the buffer to Blob
    // copies exactly the bytes we wrote.
    return patched ? new Blob([patched.buffer as ArrayBuffer], { type: blob.type }) : blob;
  } catch {
    return blob;
  }
}
