import { NextResponse } from 'next/server';
import { checkRateLimit, rateLimitHeaders, RATE_LIMIT_CONFIGS } from '@/lib/rate-limit';

export async function refuseIfAgentRunLimited(
  userId: string,
  versionId: string
): Promise<NextResponse | null> {
  const cfg = RATE_LIMIT_CONFIGS['agent-run'];
  const result = await checkRateLimit(`${userId}:${versionId}`, 'agent-run');
  if (result.allowed) return null;
  return NextResponse.json(
    { error: 'Too many requests. Please try again later.' },
    { status: 429, headers: rateLimitHeaders(result, cfg.maxRequests) }
  );
}
