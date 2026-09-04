import { afterEach, describe, expect, it, vi } from 'vitest';
import { scheduleVersionTranscription } from '@/lib/transcription/schedule';

const afterMock = vi.hoisted(() => vi.fn());
const runMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('next/server', () => ({
  after: afterMock,
}));

vi.mock('@/lib/transcription/run-version', () => ({
  runTranscriptionForVersion: runMock,
}));

describe('scheduleVersionTranscription', () => {
  afterEach(() => {
    afterMock.mockReset();
    runMock.mockReset();
    runMock.mockResolvedValue(undefined);
  });

  it('registers work with after() and the callback transcribes that version', async () => {
    afterMock.mockImplementation(() => undefined);
    scheduleVersionTranscription('ver_inline', 'en');

    expect(afterMock).toHaveBeenCalledTimes(1);
    expect(runMock).not.toHaveBeenCalled();

    const work = afterMock.mock.calls[0]?.[0] as () => Promise<unknown>;
    await work();

    expect(runMock).toHaveBeenCalledWith({
      versionId: 'ver_inline',
      language: 'en',
      transcriptId: undefined,
    });
    expect(runMock).toHaveBeenCalledTimes(1);
  });

  it('runs transcription immediately when after() throws', () => {
    afterMock.mockImplementation(() => {
      throw new Error('outside request scope');
    });

    scheduleVersionTranscription('ver_fallback', 'fr');

    expect(runMock).toHaveBeenCalledWith({
      versionId: 'ver_fallback',
      language: 'fr',
      transcriptId: undefined,
    });
    expect(runMock).toHaveBeenCalledTimes(1);
  });

  it('defaults a one-argument call to undetermined, not English', async () => {
    afterMock.mockImplementation(() => undefined);
    scheduleVersionTranscription('ver_default');

    const work = afterMock.mock.calls[0]?.[0] as () => Promise<unknown>;
    await work();

    expect(runMock).toHaveBeenCalledWith({
      versionId: 'ver_default',
      language: 'und',
      transcriptId: undefined,
    });
  });
});
