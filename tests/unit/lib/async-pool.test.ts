import { describe, expect, it, vi } from 'vitest';
import { runWithConcurrency } from '@/lib/async-pool';

function tick(ms = 1): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe('runWithConcurrency', () => {
  it('never calls the worker for an empty list', async () => {
    const worker = vi.fn();

    await runWithConcurrency([], 4, worker);

    expect(worker).not.toHaveBeenCalled();
  });

  it('processes every item exactly once', async () => {
    const items = ['a', 'b', 'c', 'd', 'e'];
    const seen: string[] = [];

    await runWithConcurrency(items, 2, async (item) => {
      await tick();
      seen.push(item);
    });

    expect([...seen].sort()).toEqual([...items].sort());
    expect(seen).toHaveLength(items.length);
  });

  it('starts items in input order even though they finish out of order', async () => {
    const started: number[] = [];

    await runWithConcurrency([1, 2, 3, 4, 5, 6], 3, async (item) => {
      started.push(item);
      await tick(7 - item);
    });

    expect(started.slice(0, 3)).toEqual([1, 2, 3]);
    expect([...started].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('never exceeds the requested concurrency', async () => {
    let inFlight = 0;
    let peak = 0;

    await runWithConcurrency(
      Array.from({ length: 12 }, (_unused, i) => i),
      3,
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await tick();
        inFlight -= 1;
      }
    );

    expect(peak).toBe(3);
    expect(inFlight).toBe(0);
  });

  it('reaches the requested concurrency rather than serialising', async () => {
    let peak = 0;
    let inFlight = 0;

    await runWithConcurrency(
      Array.from({ length: 20 }, (_unused, i) => i),
      5,
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await tick();
        inFlight -= 1;
      }
    );

    expect(peak).toBe(5);
  });

  it('caps the worker count at the number of items', async () => {
    let peak = 0;
    let inFlight = 0;

    await runWithConcurrency([1, 2], 50, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight -= 1;
    });

    expect(peak).toBe(2);
  });

  it.each([0, -5, 0.5])('treats the limit %s as a single worker', async (limit) => {
    let peak = 0;
    let inFlight = 0;

    await runWithConcurrency([1, 2, 3, 4], limit, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight -= 1;
    });

    expect(peak).toBe(1);
  });

  it('floors a fractional limit', async () => {
    let peak = 0;
    let inFlight = 0;

    await runWithConcurrency([1, 2, 3, 4, 5, 6], 2.9, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight -= 1;
    });

    expect(peak).toBe(2);
  });

  it('rejects with the worker error when one item fails', async () => {
    const failure = new Error('item 3 failed');

    await expect(
      runWithConcurrency([1, 2, 3, 4], 1, async (item) => {
        if (item === 3) throw failure;
      })
    ).rejects.toBe(failure);
  });

  it('lets items already dispatched by other workers finish after a failure', async () => {
    const completed: number[] = [];

    // Two workers: worker A picks item 1 and throws, worker B picks item 2 and
    // finishes. Promise.all rejects on A, but B's work is not cancelled.
    await expect(
      runWithConcurrency([1, 2], 2, async (item) => {
        if (item === 1) {
          throw new Error('boom');
        }
        await tick();
        completed.push(item);
      })
    ).rejects.toThrow('boom');

    await tick(5);
    expect(completed).toEqual([2]);
  });

  it('stops pulling new items in the worker that threw', async () => {
    const seen: number[] = [];

    await expect(
      runWithConcurrency([1, 2, 3, 4, 5], 1, async (item) => {
        seen.push(item);
        if (item === 2) throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    expect(seen).toEqual([1, 2]);
  });

  it('resolves to undefined rather than a result array', async () => {
    await expect(runWithConcurrency([1, 2], 2, async () => {})).resolves.toBeUndefined();
  });

  it('lets the caller preserve input order by writing into an indexed array', async () => {
    const items = ['a', 'b', 'c', 'd'];
    const results: string[] = [];

    await runWithConcurrency(
      items.map((value, index) => ({ value, index })),
      3,
      async ({ value, index }) => {
        await tick(4 - index);
        results[index] = value.toUpperCase();
      }
    );

    expect(results).toEqual(['A', 'B', 'C', 'D']);
  });
});
