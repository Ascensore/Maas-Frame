import { editPlanSchema } from '@/lib/agents/edit-plan';
import type { EditPlan } from '@/lib/agents/types';
import type { CommentEditSnapshot } from './plan';
import type { CommentEditChange } from './types';

/** New runs identify each plan explicitly; older batches used sorted comment order. */
export function previousCommentPlan(
  result: unknown,
  commentId: string,
  memberIds?: string[]
): EditPlan | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const stored = result as Record<string, unknown>;
  const byComment = stored.plansByCommentId;
  let candidate: unknown;
  if (byComment && typeof byComment === 'object' && !Array.isArray(byComment)) {
    candidate = (byComment as Record<string, unknown>)[commentId];
  } else if (Array.isArray(stored.plans) && stored.plans.length > 1) {
    if (!memberIds || memberIds.length !== stored.plans.length || !memberIds.includes(commentId))
      return null;
    candidate = stored.plans[memberIds.indexOf(commentId)];
  } else {
    candidate = stored.editPlan;
  }
  const parsed = editPlanSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export function describeCommentPlan(
  plan: EditPlan | null,
  snapshot: CommentEditSnapshot | null
): CommentEditChange[] {
  return (plan?.operations ?? []).map((operation) => {
    let detail: string;
    switch (operation.op) {
      case 'cut':
        detail = 'Remove footage';
        break;
      case 'keep':
        detail = 'Keep footage within the marked range';
        break;
      case 'graphic': {
        const preset = snapshot?.presets?.find((p) => p.id === operation.presetId);
        detail = `${preset?.name ?? 'Graphic'}: ${operation.title}${operation.subtitle ? ' — ' + operation.subtitle : ''}`;
        break;
      }
      case 'broll': {
        const asset = snapshot?.assets?.find((a) => a.versionId === operation.assetVersionId);
        detail = `B-roll: ${asset?.title ?? 'Selected footage'}, from ${operation.sourceIn.toFixed(2)}s; keep speech audio`;
        break;
      }
    }
    return { start: operation.start, end: operation.end, detail };
  });
}
