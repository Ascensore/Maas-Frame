import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';

export async function claimPendingAgentRuns(limit = 5): Promise<string[]> {
  const take = Math.min(Math.max(Math.trunc(limit), 1), 20);
  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id
      FROM agent_runs
      WHERE status = 'PENDING'::"AgentRunStatus"
      ORDER BY created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${take}
    `);
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    await tx.agentRun.updateMany({
      where: { id: { in: ids }, status: 'PENDING' },
      data: {
        status: 'RUNNING',
        startedAt: new Date(),
        attempts: { increment: 1 },
      },
    });
    return ids;
  });
}
