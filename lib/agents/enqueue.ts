import type { AgentRun, AgentRunKind, AgentRunStatus } from '@prisma/client';
import { db } from '@/lib/db';
import { getAgentModelId } from '@/lib/feature-flags';
import { resolveAgentDefinition } from '@/lib/agents/catalog';

export type AgentRunPayload = {
  brief?: string;
};

export async function enqueueAgentRun(options: {
  versionId: string;
  triggeredById: string;
  agentSlug?: string;
  brief?: string;
}): Promise<{ run: AgentRun; created: boolean }> {
  const definition = resolveAgentDefinition(options.agentSlug);
  const existing = await db.agentRun.findFirst({
    where: {
      versionId: options.versionId,
      agentSlug: definition.slug,
      status: { in: ['PENDING', 'RUNNING'] },
    },
    orderBy: { createdAt: 'desc' },
  });
  if (existing) {
    return { run: existing, created: false };
  }

  const payload: AgentRunPayload | undefined = options.brief
    ? { brief: options.brief.trim().slice(0, 4000) }
    : undefined;

  const run = await db.agentRun.create({
    data: {
      versionId: options.versionId,
      kind: definition.kind as AgentRunKind,
      agentSlug: definition.slug,
      model: getAgentModelId(),
      triggeredById: options.triggeredById,
      payload: payload ?? undefined,
    },
  });

  return { run, created: true };
}

export function serializeAgentRun(run: {
  id: string;
  versionId: string;
  kind: AgentRunKind;
  agentSlug: string;
  status: AgentRunStatus;
  model: string;
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}) {
  return {
    id: run.id,
    versionId: run.versionId,
    kind: run.kind,
    agentSlug: run.agentSlug,
    status: run.status,
    model: run.model,
    error: run.error,
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
  };
}
