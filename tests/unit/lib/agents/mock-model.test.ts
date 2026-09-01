import { describe, expect, it } from 'vitest';
import { mockEditPlan, mockReviewFindings } from '@/lib/agents/mock-model';
import { getAgentModel } from '@/lib/agents/model';
import { TRANSCRIPT_NOT_READY_MESSAGE } from '@/lib/agents/errors';
import { agentDisplayName, resolveAgentDefinition } from '@/lib/agents/catalog';
import type { AgentContext } from '@/lib/agents/types';

function context(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    version: {
      id: 'ver_1',
      title: 'Cut 03',
      duration: 60,
      projectName: 'Spot',
      frameRateNum: 24,
      frameRateDen: 1,
    },
    transcript: {
      language: 'en',
      segments: [{ start: 1.5, end: 4, text: 'Hello from the floor' }],
    },
    comments: [],
    brief: null,
    ...overrides,
  };
}

describe('mockReviewFindings', () => {
  it('emits a summary at 0 and a ranged finding from the first cue', () => {
    const result = mockReviewFindings(context());

    expect(result.findings).toEqual([
      {
        timestamp: 0,
        body: 'Transcript review of "Cut 03". 1 cues.',
        tagName: 'Feedback',
        severity: 'info',
      },
      {
        timestamp: 1.5,
        timestampEnd: 4,
        body: 'Opening line: Hello from the floor',
        tagName: 'Creative',
        severity: 'info',
      },
    ]);
  });

  it('fails with a stable error when there is no transcript', () => {
    expect(() => mockReviewFindings(context({ transcript: null }))).toThrow(
      TRANSCRIPT_NOT_READY_MESSAGE
    );
    expect(() =>
      mockReviewFindings(context({ transcript: { language: 'en', segments: [] } }))
    ).toThrow('Transcript is not ready');
  });
});

describe('getAgentModel', () => {
  it('returns the mock implementation for mock', async () => {
    const model = getAgentModel('mock');
    expect(model.name).toBe('mock');
    const findings = await model.generateFindings({
      system: 'test',
      context: context(),
    });
    expect(findings.findings).toHaveLength(2);
  });
});

describe('mockEditPlan', () => {
  it('keeps the full duration when one is known', () => {
    expect(mockEditPlan(context())).toEqual({
      version: 1,
      operations: [{ op: 'keep', start: 0, end: 60 }],
    });
  });

  it('returns an empty plan when duration is missing', () => {
    expect(mockEditPlan(context({ version: { ...context().version, duration: null } }))).toEqual({
      version: 1,
      operations: [],
    });
  });
});

describe('agent catalog', () => {
  it('defaults an unknown slug to transcript-review and names known slugs', () => {
    expect(resolveAgentDefinition('nope').slug).toBe('transcript-review');
    expect(agentDisplayName('edit')).toBe('Edit');
    expect(agentDisplayName(null)).toBe('AI review');
  });
});
