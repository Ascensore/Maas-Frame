export class AgentReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentReviewError';
  }
}

export const TRANSCRIPT_NOT_READY_MESSAGE = 'Transcript is not ready';
