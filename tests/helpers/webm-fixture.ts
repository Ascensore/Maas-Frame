/**
 * Builds WebM bytes in the shapes MediaRecorder emits them. The two browsers
 * differ in ways this code has to survive:
 *
 *   Chrome  writes no SeekHead and no Duration at all, with compact 1-byte
 *           element sizes.
 *   Firefox writes an empty SeekHead, a Duration reserved as 0.0 that it never
 *           fills in, and 8-byte element sizes.
 *
 * Nothing here is a real audio stream; these tests only care about the
 * container fields a player reads to learn how long a recording is.
 */

const UNKNOWN_SIZE = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
const INFO_ID = [0x15, 0x49, 0xa9, 0x66];
const SEEK_HEAD_ID = [0x11, 0x4d, 0x9b, 0x74];

/** A Duration of 0.0 in an 8-byte float, the placeholder Firefox leaves behind. */
export const DURATION_PLACEHOLDER = [0x44, 0x89, 0x88, 0, 0, 0, 0, 0, 0, 0, 0];

export function ebmlElement(id: number[], content: number[], sizeWidth = 1): number[] {
  if (sizeWidth === 1) {
    if (content.length >= 127) throw new Error('a 1-byte size holds at most 126 bytes');
    return [...id, 0x80 | content.length, ...content];
  }

  // Division, not `>>`: JS shifts wrap at 32 bits and an 8-byte size needs 56.
  const size = Array.from({ length: sizeWidth }, (_, i) =>
    i === 0
      ? 0x100 >> sizeWidth
      : Math.floor(content.length / 2 ** (8 * (sizeWidth - 1 - i))) & 0xff
  );
  return [...id, ...size, ...content];
}

export function timecodeScaleElement(nanoseconds: number): number[] {
  return ebmlElement(
    [0x2a, 0xd7, 0xb1],
    [(nanoseconds >> 16) & 0xff, (nanoseconds >> 8) & 0xff, nanoseconds & 0xff]
  );
}

export const CLUSTER_BYTES = ebmlElement([0x1f, 0x43, 0xb6, 0x75], [0xe7, 0x81, 0x00]);

export function buildLiveWebm({
  info = timecodeScaleElement(1_000_000),
  seekHead = 'none',
  sizeWidth = 1,
}: {
  info?: number[];
  seekHead?: 'none' | 'empty' | 'entries';
  sizeWidth?: number;
} = {}): Uint8Array {
  const header = ebmlElement([0x1a, 0x45, 0xdf, 0xa3], [0x42, 0x86, 0x81, 0x01]);
  const seekHeadBytes =
    seekHead === 'none'
      ? []
      : ebmlElement(SEEK_HEAD_ID, seekHead === 'empty' ? [] : [0x53, 0xac, 0x81, 0xa1], sizeWidth);
  const segmentBody = [
    ...seekHeadBytes,
    ...ebmlElement(INFO_ID, info, sizeWidth),
    ...CLUSTER_BYTES,
  ];
  return new Uint8Array([...header, 0x18, 0x53, 0x80, 0x67, ...UNKNOWN_SIZE, ...segmentBody]);
}

/** Walks the file the way a player would and pulls Segment > Info > Duration. */
export function readWebmDuration(bytes: Uint8Array): number | null {
  for (let i = 0; i < bytes.length - 4; i++) {
    if (!INFO_ID.every((byte, offset) => bytes[i + offset] === byte)) continue;

    const sizeWidth = 8 - Math.floor(Math.log2(bytes[i + 4]));
    const infoStart = i + 4 + sizeWidth;
    let infoSize = bytes[i + 4] & (0xff >> sizeWidth);
    for (let k = 1; k < sizeWidth; k++) infoSize = infoSize * 0x100 + bytes[i + 4 + k];

    for (let j = infoStart; j < infoStart + infoSize - 1; j++) {
      if (bytes[j] === 0x44 && bytes[j + 1] === 0x89) {
        const width = bytes[j + 2] & 0x7f;
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        return width === 4 ? view.getFloat32(j + 3) : view.getFloat64(j + 3);
      }
    }
    return null;
  }
  return null;
}
