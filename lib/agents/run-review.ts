import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { loadAgentContext } from '@/lib/agents/context';
import { AgentReviewError, TRANSCRIPT_NOT_READY_MESSAGE } from '@/lib/agents/errors';
import { resolveAgentDefinition } from '@/lib/agents/catalog';
import { getAgentModel } from '@/lib/agents/model';
import { publishFindings } from '@/lib/agents/publish-findings';
import type { AgentRunPayload } from '@/lib/agents/enqueue';
import type { ReviewFindings, EditPlan } from '@/lib/agents/types';
import { SHORT_FORM_AI_SYSTEM } from '@/lib/short-form/ai';
import { transcriptTextForRange } from '@/lib/short-form';
import { loadSourceTranscript } from '@/lib/short-form/store';
import { executeCommentEdit } from '@/lib/comment-edit/execute';

export async function executeAgentRun(runId: string): Promise<void> {
  const run = await db.agentRun.findUnique({
    where: { id: runId },
    include: {
      commentEditTask: { select: { id: true } },
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

  if (run.kind === 'SHORTS') {
    try {
      await executeShortFormRanking(run.id, run.model);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await db.agentRun.update({
        where: { id: run.id },
        data: { status: 'FAILED', error: message.slice(0, 4000), finishedAt: new Date() },
      });
      const batch = await db.shortFormBatch.findUnique({ where: { agentRunId: run.id } });
      if (batch) {
        const warnings = Array.isArray(batch.warnings) ? batch.warnings.map(String) : [];
        await db.shortFormBatch.update({
          where: { id: batch.id },
          data: {
            status: 'READY',
            warnings: [...warnings, 'AI reranking failed; deterministic ranking was kept.'],
          },
        });
      }
      throw error;
    }
  }

  const definition = resolveAgentDefinition(run.agentSlug);
  const payload = asPayload(run.payload);
  const brief = payload.brief ?? null;

  try {
    if (run.commentEditTask) {
      await executeCommentEdit(run.id);
      return;
    }
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

async function executeShortFormRanking(runId: string, modelId: string): Promise<void> {
  const batch = await db.shortFormBatch.findUnique({
    where: { agentRunId: runId },
    include: { candidates: { orderBy: { rank: 'asc' } } },
  });
  if (!batch) throw new Error('Short-form batch for agent run not found');
  const model = getAgentModel(modelId);
  const transcript = await loadSourceTranscript(batch.sourceVersionId);
  const ranked = await model.rankShorts({
    system: SHORT_FORM_AI_SYSTEM,
    context: {
      candidates: batch.candidates.map((candidate) => ({
        id: candidate.id,
        start: candidate.sourceStartSec,
        end: candidate.sourceEndSec,
        transcript: transcriptTextForRange(
          transcript,
          candidate.sourceStartSec,
          candidate.sourceEndSec
        ),
        deterministicScore: candidate.score,
      })),
    },
  });
  const expected = new Set(batch.candidates.map((candidate) => candidate.id));
  if (
    ranked.candidates.length !== expected.size ||
    ranked.candidates.some((candidate) => !expected.has(candidate.id))
  ) {
    throw new Error('AI reranker returned unknown or missing candidates');
  }
  await db.$transaction(async (tx) => {
    // Temporary negative ranks avoid the per-batch unique index while swapping order.
    await Promise.all(
      batch.candidates.map((candidate, index) =>
        tx.shortFormCandidate.update({ where: { id: candidate.id }, data: { rank: -(index + 1) } })
      )
    );
    for (const candidate of ranked.candidates) {
      await tx.shortFormCandidate.update({
        where: { id: candidate.id },
        data: {
          rank: candidate.rank,
          title: candidate.title,
          socialCaption: candidate.socialCaption,
          hashtags: candidate.hashtags,
          rationale: `${candidate.rationale}\nHook: ${candidate.hook}`,
        },
      });
    }
    await tx.agentRun.update({
      where: { id: runId },
      data: { status: 'SUCCEEDED', result: ranked, error: null, finishedAt: new Date() },
    });
    await tx.shortFormBatch.update({
      where: { id: batch.id },
      data: { status: 'READY', error: null },
    });
  });
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
