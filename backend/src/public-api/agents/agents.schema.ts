import { z } from 'zod';
import { CursorPageQuerySchema, pageSchema } from '../pagination';

export const AgentSchema = z
  .strictObject({
    id: z.string(),
    name: z.string(),
    displayName: z.string().nullable(),
    description: z.string().nullable(),
  })
  .meta({ id: 'Agent' });

export const AgentPageSchema = pageSchema(AgentSchema, 'AgentPage');

export const AgentListQuerySchema = CursorPageQuerySchema;

export type AgentDto = z.infer<typeof AgentSchema>;
export type AgentPageDto = z.infer<typeof AgentPageSchema>;
export type AgentListQuery = z.infer<typeof AgentListQuerySchema>;
