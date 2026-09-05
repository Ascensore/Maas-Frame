import { z } from 'zod';

export const shortFormAiResultSchema = z.object({
  candidates: z.array(
    z.object({
      id: z.string(),
      rank: z.number().int().positive(),
      title: z.string().min(1).max(120),
      socialCaption: z.string().max(2200),
      hashtags: z.array(z.string().max(80)).max(30),
      hook: z.string().max(300),
      rationale: z.string().max(1000),
    })
  ),
});

export type ShortFormAiResult = z.infer<typeof shortFormAiResultSchema>;
export type ShortFormAiInput = {
  candidates: Array<{
    id: string;
    start: number;
    end: number;
    transcript: string;
    deterministicScore: number;
  }>;
};

export const SHORT_FORM_AI_SYSTEM = `You are ranking proposed short clips from a completed talking-head edit.
You receive transcript text and deterministic scores only, never media. Preserve every candidate id. Rank for a
self-contained hook and payoff, topical variety, and usefulness on Reels/Shorts. Write a concise title, social
caption, 3–6 relevant hashtags beginning with #, a hook, and an evidence-based rationale. Do not invent facts.`;
