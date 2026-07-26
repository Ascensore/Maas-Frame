import {
  ApprovalDecisionStatus,
  ApprovalRequestStatus,
  type ApprovalDecision,
  type ApprovalRequest,
} from '@prisma/client';
import { db } from '@/lib/db';
import { nextSeq } from './seq';

export interface CreateApprovalRequestInput {
  versionId: string;
  requestedById: string;
  /** Users who get a PENDING decision row, i.e. the ones allowed to decide. */
  approverIds?: string[];
  message?: string | null;
  status?: ApprovalRequestStatus;
  resolvedAt?: Date | null;
  canceledAt?: Date | null;
  canceledById?: string | null;
}

export async function createApprovalRequest(
  input: CreateApprovalRequestInput
): Promise<ApprovalRequest & { decisions: ApprovalDecision[] }> {
  const seq = nextSeq();
  return db.approvalRequest.create({
    data: {
      versionId: input.versionId,
      requestedById: input.requestedById,
      message: input.message === undefined ? `Please review, round ${seq}` : input.message,
      status: input.status ?? ApprovalRequestStatus.PENDING,
      resolvedAt: input.resolvedAt ?? null,
      canceledAt: input.canceledAt ?? null,
      canceledById: input.canceledById ?? null,
      decisions: {
        create: (input.approverIds ?? []).map((approverId) => ({
          approverId,
          status: ApprovalDecisionStatus.PENDING,
        })),
      },
    },
    include: { decisions: true },
  });
}
