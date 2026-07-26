// Capture for the mocked `nodemailer` transport installed in
// tests/setup/api.ts. Every sendMail() call lands here instead of on the wire.
//
// The store hangs off globalThis because the vi.mock factory in the setup file
// and the test file that asserts on it are separate module instances in some
// Vitest isolation modes; a plain module-level array would not be shared.

export interface CapturedMail {
  from?: string;
  to?: string;
  subject?: string;
  html?: string;
  text?: string;
}

const globalForMail = globalThis as unknown as { __openframeCapturedMail?: CapturedMail[] };

function store(): CapturedMail[] {
  globalForMail.__openframeCapturedMail ??= [];
  return globalForMail.__openframeCapturedMail;
}

export function recordSentMail(message: unknown): void {
  const record = (message ?? {}) as Record<string, unknown>;
  store().push({
    from: typeof record.from === 'string' ? record.from : undefined,
    to: typeof record.to === 'string' ? record.to : undefined,
    subject: typeof record.subject === 'string' ? record.subject : undefined,
    html: typeof record.html === 'string' ? record.html : undefined,
    text: typeof record.text === 'string' ? record.text : undefined,
  });
}

/** Everything sent since the last reset, oldest first. */
export function sentMail(): readonly CapturedMail[] {
  return store();
}

/** Messages addressed to one recipient, case-insensitive. */
export function mailTo(address: string): readonly CapturedMail[] {
  const needle = address.toLowerCase();
  return store().filter((mail) => mail.to?.toLowerCase() === needle);
}

export function resetSentMail(): void {
  store().length = 0;
}
