import { getAgentModelId } from '@/lib/feature-flags';
import { createAiSdkAgentModel } from '@/lib/agents/ai-sdk-model';
import { MOCK_MODEL_NAME, createMockAgentModel } from '@/lib/agents/mock-model';
import type { AgentModel } from '@/lib/agents/types';

export function getAgentModel(modelId = getAgentModelId()): AgentModel {
  if (modelId === MOCK_MODEL_NAME) {
    return createMockAgentModel();
  }
  return createAiSdkAgentModel(modelId);
}
