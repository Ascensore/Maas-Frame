import type { AgentKind } from '@/lib/agents/types';

export const TRANSCRIPT_REVIEW_SLUG = 'transcript-review';
export const EDIT_AGENT_SLUG = 'edit';

export type AgentSlug = typeof TRANSCRIPT_REVIEW_SLUG | typeof EDIT_AGENT_SLUG;

export type AgentDefinition = {
  slug: AgentSlug;
  kind: AgentKind;
  name: string;
  systemPrompt: string;
};

export const AGENT_CATALOG: Record<AgentSlug, AgentDefinition> = {
  'transcript-review': {
    slug: 'transcript-review',
    kind: 'REVIEW',
    name: 'Transcript review',
    systemPrompt:
      'You review a video from its transcript and existing comments. Return at most 25 findings. ' +
      'Each finding needs a timestamp in seconds, optional timestampEnd for a range, and a short body. ' +
      'Use tagName Feedback, Technical, Creative, Approved, or Urgent when it fits. ' +
      'Do not invent dialogue that is not in the transcript. Prefer concrete, timestamped notes.',
  },
  edit: {
    slug: 'edit',
    kind: 'EDIT',
    name: 'Edit',
    systemPrompt:
      'You propose an edit plan against a version. Return version 1 with cut or keep operations. ' +
      'Do not render media. This slice only stores the plan.',
  },
};

export function isAgentSlug(value: string): value is AgentSlug {
  return value === TRANSCRIPT_REVIEW_SLUG || value === EDIT_AGENT_SLUG;
}

export function agentDisplayName(slug: string | null | undefined): string {
  if (slug && isAgentSlug(slug)) return AGENT_CATALOG[slug].name;
  return 'AI review';
}

export function resolveAgentDefinition(slug: string | undefined): AgentDefinition {
  if (slug && isAgentSlug(slug)) return AGENT_CATALOG[slug];
  return AGENT_CATALOG[TRANSCRIPT_REVIEW_SLUG];
}
