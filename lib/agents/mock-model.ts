import { TRANSCRIPT_NOT_READY_MESSAGE } from '@/lib/agents/errors';
import { emptyEditPlan } from '@/lib/agents/edit-plan';
import type { AgentContext, AgentModel, EditPlan, ReviewFindings } from '@/lib/agents/types';

export const MOCK_MODEL_NAME = 'mock';

export function mockReviewFindings(context: AgentContext): ReviewFindings {
  if (!context.transcript || context.transcript.segments.length === 0) {
    throw new Error(TRANSCRIPT_NOT_READY_MESSAGE);
  }

  const first = context.transcript.segments[0];
  const title = context.version.title || 'this version';
  const findings: ReviewFindings['findings'] = [
    {
      timestamp: 0,
      body: `Transcript review of "${title}". ${context.transcript.segments.length} cues.`,
      tagName: 'Feedback',
      severity: 'info',
    },
    {
      timestamp: first.start,
      timestampEnd: first.end,
      body: `Opening line: ${first.text}`,
      tagName: 'Creative',
      severity: 'info',
    },
  ];

  return { findings, summary: 'Mock transcript review' };
}

export function mockEditPlan(context: AgentContext): EditPlan {
  const end = context.version.duration ?? 0;
  if (end <= 0) return emptyEditPlan();
  return { version: 1, operations: [{ op: 'keep', start: 0, end }] };
}

export function createMockAgentModel(): AgentModel {
  return {
    name: MOCK_MODEL_NAME,
    async generateFindings({ context }): Promise<ReviewFindings> {
      return mockReviewFindings(context);
    },
    async generateEditPlan({ context }): Promise<EditPlan> {
      return mockEditPlan(context);
    },
  };
}
