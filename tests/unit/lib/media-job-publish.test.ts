import { describe, expect, it, vi } from 'vitest';
import {
  publishClaimedJobs,
  UnknownJobKindError,
  type PublishableMediaJob,
} from '@/lib/media-job-queue';

/**
 * What happens to a batch of claimed jobs when one of them will not publish.
 *
 * The batch has already been committed as QUEUED by the time this runs, and
 * nothing in the system ever moves a QUEUED row back, so whether this function
 * carries on or gives up decides whether the jobs behind the failing one are
 * merely late or lost.
 */

function job(id: string, kind: string): PublishableMediaJob {
  return { id, kind, versionId: `version-for-${id}`, payload: null };
}

describe('publishClaimedJobs', () => {
  it('publishes every job when the queue takes them all', async () => {
    const sent: string[] = [];
    const released: string[] = [];

    await publishClaimedJobs(
      [job('a', 'PROBE_MEDIA'), job('b', 'TRANSCRIBE')],
      async (entry) => {
        sent.push(entry.id);
      },
      async (id) => {
        released.push(id);
      }
    );

    expect(sent).toEqual(['a', 'b']);
    expect(released).toEqual([]);
  });

  it('skips a kind this worker has no queue for and publishes the rest of the batch', async () => {
    // The scenario the fix exists for: an app that can queue BURN_SUBTITLES
    // against a worker image built before it existed. Giving up here would
    // leave every job claimed after the burn-in stuck at QUEUED forever, so a
    // single unknown job would stop probes and transcription behind it.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sent: string[] = [];
    const released: string[] = [];

    try {
      await publishClaimedJobs(
        [job('burn-1', 'BURN_SUBTITLES'), job('probe-1', 'PROBE_MEDIA')],
        async (entry) => {
          if (entry.kind === 'BURN_SUBTITLES') throw new UnknownJobKindError(entry.kind);
          sent.push(entry.id);
        },
        async (id) => {
          released.push(id);
        }
      );

      // The job behind it still reached the queue...
      expect(sent).toEqual(['probe-1']);
      // ...and the one that could not be published is back to PENDING, so a
      // rebuilt worker picks it up rather than having to be told about it.
      expect(released).toEqual(['burn-1']);
      // Named in the log, with the hint an operator can act on.
      const message = String(logged.mock.calls[0]?.[0]);
      expect(message).toContain('burn-1');
      expect(message).toContain('BURN_SUBTITLES');
      expect(message).toContain('worker image is out of date');
    } finally {
      logged.mockRestore();
    }
  });

  it('stops the batch on any other failure, after putting that job back', async () => {
    // A queue that is down is not worth grinding through the rest of the batch
    // for: every send would fail the same way, and the next tick has nothing to
    // publish to either. The row still goes back to PENDING on the way out.
    const sent: string[] = [];
    const released: string[] = [];

    await expect(
      publishClaimedJobs(
        [job('a', 'PROBE_MEDIA'), job('b', 'TRANSCRIBE')],
        async (entry) => {
          if (entry.id === 'a') throw new Error('pg-boss is unreachable');
          sent.push(entry.id);
        },
        async (id) => {
          released.push(id);
        }
      )
    ).rejects.toThrow(/pg-boss is unreachable/);

    expect(sent).toEqual([]);
    expect(released).toEqual(['a']);
  });
});
