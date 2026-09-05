import { generateText, Output } from 'ai';
import { emptyEditPlan, parseEditPlan, editPlanSchema } from '@/lib/agents/edit-plan';
import { parseReviewFindings, reviewFindingsSchema } from '@/lib/agents/findings';
import type { AgentContext, AgentModel, EditPlan, ReviewFindings } from '@/lib/agents/types';
import { shortFormAiResultSchema, type ShortFormAiResult } from '@/lib/short-form/ai';

function contextPrompt(context: AgentContext): string {
  return JSON.stringify(
    {
      version: context.version,
      brief: context.brief,
      transcript: context.transcript,
      comments: context.comments,
    },
    null,
    2
  );
}

export function createAiSdkAgentModel(modelId: string): AgentModel {
  return {
    name: modelId,
    async generateFindings({ system, context }): Promise<ReviewFindings> {
      const result = await generateText({
        model: modelId,
        system,
        prompt: contextPrompt(context),
        output: Output.object({ schema: reviewFindingsSchema }),
      });
      return parseReviewFindings(result.output);
    },
    async generateEditPlan({ system, context }): Promise<EditPlan> {
      const result = await generateText({
        model: modelId,
        system,
        prompt: contextPrompt(context),
        output: Output.object({ schema: editPlanSchema }),
      });
      if (!result.output) return emptyEditPlan();
      return parseEditPlan(result.output);
    },
    async rankShorts({ system, context }): Promise<ShortFormAiResult> {
      const result = await generateText({
        model: modelId,
        system,
        prompt: JSON.stringify(context, null, 2),
        output: Output.object({ schema: shortFormAiResultSchema }),
      });
      return shortFormAiResultSchema.parse(result.output);
    },
  };
}
