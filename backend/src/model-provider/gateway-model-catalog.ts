import type { BaseFormatId } from './base-formats';

// Additional models available to gateway consumers, independent of the agent
// picker in agent-config/models.json. Keep provider key restrictions in force.
export const GATEWAY_ONLY_MODELS: Record<BaseFormatId, readonly string[]> = {
  openai: ['gpt-6.1-terra', 'gpt-6-luna'],
  anthropic: [],
};
