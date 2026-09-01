import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { loadAgentContext } from '@/lib/agents/context';
import { AgentReviewError, TRANSCRIPT_NOT_READY_MESSAGE } from '@/lib/agents/errors';
import { resolveAgentDefinition } from '@/lib/agents/catalog';
import { getAgentModel } from '@/lib/agents/model';
import { publishFindings } from '@/lib/agents/publish-findings';
import type { AgentRunPayload } from '@/lib/agents/enqueue';
import type { ReviewFindings, EditPlan } from '@/lib/agents/types';

export async function executeAgentRun(runId: string): Promise<void> {
  const run = await db.agentRun.findUnique({
    where: { id: runId },
    include: {
      version: {
        select: {
          id: true,
          duration: true,
          frameRateNum: true,
          frameRateDen: true,
          video: { select: { projectId: true } },
        },
      },
    },
  });
  if (!run) {
    throw new Error(`Agent run ${runId} not found`);
  }
  if (run.status === 'SUCCEEDED' || run.status === 'CANCELED') {
    return;
  }

  const definition = resolveAgentDefinition(run.agentSlug);
  const payload = asPayload(run.payload);
  const brief = payload.brief ?? null;

  try {
    const context = await loadAgentContext(run.versionId, brief);
    const model = getAgentModel(run.model);

    if (definition.kind === 'EDIT') {
      const editPlan: EditPlan = await model.generateEditPlan({
        system: definition.systemPrompt,
        context,
      });
      await finishRun(run.id, JSON.parse(JSON.stringify({ editPlan })) as Prisma.InputJsonValue);
      return;
    }

    if (!context.transcript || context.transcript.segments.length === 0) {
      throw new AgentReviewError(TRANSCRIPT_NOT_READY_MESSAGE);
    }

    const findings: ReviewFindings = await model.generateFindings({
      system: definition.systemPrompt,
      context,
    });
    const published = await publishFindings({
      versionId: run.versionId,
      agentRunId: run.id,
      agentSlug: definition.slug,
      findings: findings.findings,
      duration: context.version.duration,
      frameRateNum: context.version.frameRateNum,
      frameRateDen: context.version.frameRateDen,
      projectId: run.version.video.projectId,
    });
    await finishRun(
      run.id,
      JSON.parse(JSON.stringify({ findings, published })) as Prisma.InputJsonValue
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.agentRun.update({
      where: { id: run.id },
      data: {
        status: 'FAILED',
        error: message.slice(0, 4000),
        finishedAt: new Date(),
      },
    });
    throw error;
  }
}

function asPayload(value: Prisma.JsonValue | null): AgentRunPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const brief = 'brief' in value && typeof value.brief === 'string' ? value.brief : undefined;
  return brief ? { brief } : {};
}

async function finishRun(id: string, result: Prisma.InputJsonValue): Promise<void> {
  await db.agentRun.update({
    where: { id },
    data: {
      status: 'SUCCEEDED',
      result,
      error: null,
      finishedAt: new Date(),
    },
  });
}
