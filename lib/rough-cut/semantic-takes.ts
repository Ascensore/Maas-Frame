import { generateText, Output } from 'ai';
import { z } from 'zod';
import { beatDuration, beatText } from './beats';
import { beatTokens, type TakeCandidate } from './takes';

export const SEMANTIC_TAKE_CONFIDENCE = 0.85;
const MAX_PROPOSED_PAIRS = 60;

const resultSchema = z.object({
  pairs: z.array(
    z.object({
      proposal: z.number().int().nonnegative(),
      sameIntent: z.boolean(),
      confidence: z.number().min(0).max(1),
      preferred: z.union([z.literal(0), z.literal(1)]),
    })
  ),
});

export function acceptedSemanticTakePairs(
  proposals: Array<{ left: number; right: number }>,
  decisions: Array<{
    proposal: number;
    sameIntent: boolean;
    confidence: number;
    preferred: 0 | 1;
  }>
): { groups: number[][]; preferred: Set<number>; reviewWarnings: number } {
  const proposalIndexes = new Set(decisions.map((decision) => decision.proposal));
  if (
    decisions.length !== proposals.length ||
    proposalIndexes.size !== proposals.length ||
    [...proposalIndexes].some((index) => index < 0 || index >= proposals.length)
  ) {
    throw new Error('Semantic take model must return every proposal exactly once');
  }
  const groups: number[][] = [];
  const preferred = new Set<number>();
  let reviewWarnings = 0;
  for (const decision of decisions) {
    const proposal = proposals[decision.proposal];
    if (!proposal || !decision.sameIntent) continue;
    if (decision.confidence < SEMANTIC_TAKE_CONFIDENCE) {
      reviewWarnings += 1;
      continue;
    }
    groups.push([proposal.left, proposal.right]);
    preferred.add(decision.preferred === 0 ? proposal.left : proposal.right);
  }
  return { groups, preferred, reviewWarnings };
}

/** Structured semantic grouping for tight mode. Only proposed transcript pairs leave the worker. */
export async function semanticTakeGroups(options: {
  candidates: TakeCandidate[];
  fillers: ReadonlySet<string>;
  model: string;
}): Promise<{ groups: number[][]; preferred: Set<number>; reviewWarnings: number }> {
  const proposals: Array<{ left: number; right: number; leftText: string; rightText: string }> = [];
  for (let left = 0; left < options.candidates.length; left += 1) {
    const a = options.candidates[left]!;
    if (beatDuration(a.beat) < 2 || beatDuration(a.beat) > 45) continue;
    if (beatTokens(a.beat, options.fillers).length < 5) continue;
    for (let right = left + 1; right < options.candidates.length; right += 1) {
      const b = options.candidates[right]!;
      if (b.timelineStart - a.timelineStart > 45) break;
      if (beatDuration(b.beat) < 2 || beatDuration(b.beat) > 45) continue;
      if (beatTokens(b.beat, options.fillers).length < 5) continue;
      proposals.push({ left, right, leftText: beatText(a.beat), rightText: beatText(b.beat) });
      if (proposals.length >= MAX_PROPOSED_PAIRS) break;
    }
    if (proposals.length >= MAX_PROPOSED_PAIRS) break;
  }
  if (proposals.length === 0) return { groups: [], preferred: new Set(), reviewWarnings: 0 };
  const response = await generateText({
    model: options.model,
    system:
      'Compare transcript pairs from adjacent talking-head takes. Mark sameIntent only when both say the same substantive line. Confidence must reflect uncertainty. Pick the more complete, fluent version. Return every proposal index once.',
    prompt: JSON.stringify(
      proposals.map((proposal, index) => ({
        proposal: index,
        first: proposal.leftText,
        second: proposal.rightText,
      }))
    ),
    output: Output.object({ schema: resultSchema }),
  });
  const parsed = resultSchema.parse(response.output);
  return acceptedSemanticTakePairs(proposals, parsed.pairs);
}
