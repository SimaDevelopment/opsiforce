import { z } from 'zod';
import { CursorPageQuerySchema, pageSchema } from '../pagination';
import { SkillFlagsSchema } from '../skills/skills.schema';

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

export const AgentSkillSchema = z
  .strictObject({
    skillId: z.string(),
    name: z.string(),
    displayName: z.string().nullable(),
    pinnedVersion: z.int().describe('The Version this Agent carries; it never moves on its own'),
    latestVersion: z.int().nullable().describe('The newest Version of the Skill, or null if it has none'),
    updateAvailable: z.boolean().describe('True when a newer Version exists than the one pinned'),
    visibility: z.enum(['private', 'public']),
    flags: SkillFlagsSchema,
  })
  .meta({ id: 'AgentSkill' });

export const AgentSkillListSchema = z.strictObject({ items: z.array(AgentSkillSchema) }).meta({
  id: 'AgentSkillList',
});

export const AgentProfileSchema = z
  .strictObject({
    environmentId: z.string().describe('Every Environment of the Organization appears, profile or not'),
    promptBody: z.string().nullable(),
    model: z.string().nullable(),
    variant: z.string().nullable().describe('Reasoning effort, when the model offers one'),
    updatedAt: z.iso.datetime().nullable(),
    skills: z
      .array(AgentSkillSchema)
      .nullable()
      .describe('null marks an Environment this Agent has no profile at; a Built-in Agent reports []'),
  })
  .meta({ id: 'AgentProfile' });

export const AgentSettingsSchema = z
  .strictObject({
    defaultEnvironmentId: z.string().nullable().describe('The profile new Projects of this Agent are created from'),
    platformApi: z.boolean().describe('Whether this Agent’s pods hold a platform-api key of their own'),
  })
  .meta({ id: 'AgentSettings' });

export const AgentDetailSchema = z
  .strictObject({
    id: z.string(),
    name: z.string().describe('Immutable kebab-case slug, derived from the display name at creation'),
    displayName: z.string().nullable(),
    description: z.string().nullable(),
    origin: z.enum(['built_in', 'custom']),
    visibility: z.enum(['private', 'public']),
    archived: z.boolean(),
    createdBy: z.string().nullable(),
    imageOwned: z.boolean().describe('True for an Agent the agent image ships; its profile is not editable'),
    live: z.boolean().describe('Whether the Agent is offered when creating a Project'),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    settings: AgentSettingsSchema,
    profiles: z.array(AgentProfileSchema).describe('Development first, then by Environment name'),
    projectCount: z.int(),
  })
  .meta({ id: 'AgentDetail' });

export const AgentPathSchema = z.strictObject({ id: z.string().min(1) });

export const AgentSkillPathSchema = z.strictObject({
  id: z.string().min(1),
  skillId: z.string().min(1),
});

export const CreateAgentSchema = z
  .strictObject({
    displayName: z.string().trim().min(1).max(80).describe('The slug is derived from this and cannot change later'),
    description: z.string().trim().max(500).optional(),
    model: z.string().min(1).optional().describe('provider/model from the deployment catalog; defaults to the registry default'),
    variant: z.string().min(1).nullable().optional().describe('Reasoning effort; must be one the model offers'),
  })
  .meta({
    id: 'CreateAgent',
    examples: [{ displayName: 'Release Notes Writer', description: 'Turns merged pull requests into release notes' }],
  });

export const UpdateAgentProfileSchema = z
  .strictObject({
    promptBody: z.string().describe('The whole system prompt body; it replaces the previous one'),
    model: z.string().min(1),
    variant: z.string().min(1).nullable().optional(),
  })
  .meta({ id: 'UpdateAgentProfile' });

export const SetAgentSkillSchema = z
  .strictObject({
    versionId: z
      .string()
      .min(1)
      .optional()
      .describe('Pin this Version of the Skill; omit to pin the latest. Send {} to add at latest.'),
  })
  .meta({ id: 'SetAgentSkill', examples: [{}] });

export const DuplicateAgentSchema = z
  .strictObject({ displayName: z.string().trim().min(1).max(80) })
  .meta({ id: 'DuplicateAgent' });

export type AgentDto = z.infer<typeof AgentSchema>;
export type AgentPageDto = z.infer<typeof AgentPageSchema>;
export type AgentListQuery = z.infer<typeof AgentListQuerySchema>;
export type AgentSkillDto = z.infer<typeof AgentSkillSchema>;
export type AgentSkillListDto = z.infer<typeof AgentSkillListSchema>;
export type AgentDetailDto = z.infer<typeof AgentDetailSchema>;
export type AgentPath = z.infer<typeof AgentPathSchema>;
export type AgentSkillPath = z.infer<typeof AgentSkillPathSchema>;
export type CreateAgent = z.infer<typeof CreateAgentSchema>;
export type UpdateAgentProfile = z.infer<typeof UpdateAgentProfileSchema>;
export type SetAgentSkill = z.infer<typeof SetAgentSkillSchema>;
export type DuplicateAgent = z.infer<typeof DuplicateAgentSchema>;
