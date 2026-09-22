import type { AgentRow } from './agents.repository';
import type { AgentDto } from './agents.schema';

export const AgentMapper = {
  toDto: ({ id, name, displayName, description }: AgentRow): AgentDto => ({ id, name, displayName, description }),
};
