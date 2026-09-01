import { z } from 'zod';
import type { ReviewFinding, ReviewFindings } from '@/lib/agents/types';

const TAG_NAMES = ['Feedback', 'Technical', 'Creative', 'Approved', 'Urgent'] as const;
const SEVERITIES = ['info', 'warning', 'blocker'] as const;

export const reviewFindingSchema = z.object({
  timestamp: z.number().finite().nonnegative(),
  timestampEnd: z.number().finite().nonnegative().nullable().optional(),
  body: z.string().trim().min(1).max(10000),
  tagName: z.enum(TAG_NAMES).optional(),
  severity: z.enum(SEVERITIES).optional(),
});

export const reviewFindingsSchema = z.object({
  findings: z.array(reviewFindingSchema).max(25),
  summary: z.string().trim().max(2000).optional(),
});

export function parseReviewFindings(value: unknown): ReviewFindings {
  const parsed = reviewFindingsSchema.parse(value);
  return {
    findings: parsed.findings.map(normalizeFinding),
    summary: parsed.summary,
  };
}

export function capFindings(findings: ReviewFinding[]): ReviewFinding[] {
  return findings.slice(0, 25);
}

export function constrainFindingTimes(
  finding: ReviewFinding,
  duration: number | null
): ReviewFinding {
  let timestamp = finding.timestamp;
  let timestampEnd = finding.timestampEnd ?? null;

  if (duration !== null && Number.isFinite(duration) && duration >= 0) {
    timestamp = Math.min(timestamp, duration);
    if (timestampEnd !== null) {
      timestampEnd = Math.min(timestampEnd, duration);
    }
  }

  if (timestampEnd !== null && timestampEnd < timestamp) {
    const swapped = timestamp;
    timestamp = timestampEnd;
    timestampEnd = swapped;
  }

  if (timestampEnd !== null && timestampEnd === timestamp) {
    timestampEnd = null;
  }

  return {
    ...finding,
    timestamp,
    timestampEnd,
  };
}

export function prepareFindingsForPublish(
  findings: ReviewFinding[],
  duration: number | null
): ReviewFinding[] {
  return capFindings(findings).map((finding) => constrainFindingTimes(finding, duration));
}

function normalizeFinding(finding: z.infer<typeof reviewFindingSchema>): ReviewFinding {
  return {
    timestamp: finding.timestamp,
    timestampEnd: finding.timestampEnd ?? null,
    body: finding.body,
    tagName: finding.tagName,
    severity: finding.severity,
  };
}
