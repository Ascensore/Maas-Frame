// The size a client declares before a direct upload starts.
//
// Shared because the R2 and Bunny paths have to agree on it: both hand the
// number to the storage quota before a single byte moves, so a value one of them
// would accept and the other would not is a hole in whichever is laxer.

export type DeclaredUploadSize = { sizeBytes: bigint } | { error: string };

/**
 * A byte count in the unit a person reading a limit expects.
 *
 * Whole gigabytes where the number is whole, which most ceilings we ship are,
 * and one decimal otherwise so a share of a small quota is not rounded into a
 * lie. Lives here rather than next to the quota because the upload routes need
 * it too, and this module imports nothing.
 */
export function formatSizeLimit(bytes: bigint): string {
  const gigabytes = Number(bytes) / 1024 ** 3;
  if (gigabytes < 1) return `${Math.round(Number(bytes) / 1024 ** 2)} MB`;
  return `${Number.isInteger(gigabytes) ? gigabytes : gigabytes.toFixed(1)} GB`;
}

/** The refusal, with the ceiling in it, so the client knows what would fit. */
export function uploadTooLargeMessage(maxBytes: bigint): string {
  return `File exceeds the maximum allowed upload size (${formatSizeLimit(maxBytes)})`;
}

/**
 * Reads a declared upload size, refusing anything that is not a whole positive
 * number of bytes within the ceiling this account is held to.
 *
 * The number is the client's word and is treated as such. Overstating it only
 * spends the caller's own quota, and understating it is caught where the bytes
 * land: R2 compares the object against the declaration and deletes it on a
 * mismatch, and Bunny's own storage reporting replaces the estimate once the
 * upload settles. What is not tolerated is an absent or nonsense value, which is
 * what asking for zero bytes effectively was.
 */
export function parseDeclaredUploadSize(raw: unknown, maxBytes: bigint): DeclaredUploadSize {
  if (typeof raw !== 'number' && typeof raw !== 'string' && typeof raw !== 'bigint') {
    return { error: 'sizeBytes must be a positive integer' };
  }

  let sizeBytes: bigint;
  try {
    sizeBytes = BigInt(raw);
  } catch {
    return { error: 'sizeBytes must be a positive integer' };
  }

  if (sizeBytes <= BigInt(0)) {
    return { error: 'sizeBytes must be a positive integer' };
  }

  if (sizeBytes > maxBytes) {
    return { error: uploadTooLargeMessage(maxBytes) };
  }

  return { sizeBytes };
}
