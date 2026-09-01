import { describe, expect, it } from 'vitest';
import { emptyEditPlan, parseEditPlan } from '@/lib/agents/edit-plan';

describe('parseEditPlan', () => {
  it('accepts version 1 cut and keep operations', () => {
    expect(
      parseEditPlan({
        version: 1,
        operations: [
          { op: 'keep', start: 0, end: 10 },
          { op: 'cut', start: 10, end: 12 },
        ],
      })
    ).toEqual({
      version: 1,
      operations: [
        { op: 'keep', start: 0, end: 10 },
        { op: 'cut', start: 10, end: 12 },
      ],
    });
  });

  it('rejects an operation whose end is before its start', () => {
    expect(() =>
      parseEditPlan({
        version: 1,
        operations: [{ op: 'cut', start: 12, end: 4 }],
      })
    ).toThrow();
  });

  it('rejects a plan that is not version 1', () => {
    expect(() => parseEditPlan({ version: 2, operations: [] })).toThrow();
  });
});

describe('emptyEditPlan', () => {
  it('returns version 1 with no operations', () => {
    expect(emptyEditPlan()).toEqual({ version: 1, operations: [] });
  });
});
