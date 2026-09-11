import { z } from 'zod';
import { AgentStatus, ProjectStatus } from '../../project/project.types';
import { CursorPageQueryShape, pageSchema } from '../pagination';

export const ResourceRefSchema = z.strictObject({ id: z.string(), name: z.string() }).meta({ id: 'ResourceRef' });

export const WorkspaceRefSchema = z
  .strictObject({ id: z.string(), name: z.string(), type: z.enum(['private', 'shared']) })
  .meta({ id: 'WorkspaceRef' });

export const OpencodeDescriptorSchema = z
  .strictObject({
    baseUrl: z
      .string()
      .describe(
        "Origin-relative base URL of this environment's opencode runtime; resolve it against the origin you called this API on"
      ),
    openapiUrl: z.string().describe("The runtime's own OpenAPI document, origin-relative"),
    sessionId: z
      .string()
      .nullable()
      .describe(
        'The primary Session every surface shares, as last remembered; null until the first connection binds one'
      ),
  })
  .meta({
    id: 'OpencodeDescriptor',
    examples: [
      {
        baseUrl: '/api/proxy/aa5d8f0e-1c2b-4f77-9a6e-2f0b8d3c4e51',
        openapiUrl: '/api/proxy/aa5d8f0e-1c2b-4f77-9a6e-2f0b8d3c4e51/openapi.json',
        sessionId: 'ses_f6fd24757ffeaALWEb4AI7eXAf',
      },
    ],
  });

export const EnvironmentSchema = z
  .strictObject({
    id: z.string(),
    name: z.string(),
    slug: z.string().nullable(),
    isDefault: z.boolean(),
    status: z.enum(ProjectStatus),
    hasApp: z.boolean(),
    appName: z.string().nullable(),
    lastActiveAt: z.iso.datetime().nullable(),
    opencode: OpencodeDescriptorSchema,
  })
  .meta({ id: 'Environment' });

export const ConnectionSchema = z
  .strictObject({
    baseUrl: z.string(),
    openapiUrl: z.string(),
    sessionId: z.string().describe('The primary Session, resolved and persisted by this call'),
    build: z
      .string()
      .nullable()
      .describe('The build the ready runtime reported during this connection, or null if it does not identify one'),
  })
  .meta({
    id: 'Connection',
    examples: [
      {
        baseUrl: '/api/proxy/aa5d8f0e-1c2b-4f77-9a6e-2f0b8d3c4e51',
        openapiUrl: '/api/proxy/aa5d8f0e-1c2b-4f77-9a6e-2f0b8d3c4e51/openapi.json',
        sessionId: 'ses_f6fd24757ffeaALWEb4AI7eXAf',
        build: '0.0.0-beta-19059',
      },
    ],
  });

export const EnvironmentPathSchema = z.strictObject({
  id: z.string().min(1),
  environmentId: z.string().min(1),
});

export const ProjectSchema = z
  .strictObject({
    id: z.string(),
    title: z.string().nullable(),
    description: z.string().nullable(),
    agent: ResourceRefSchema,
    workspace: WorkspaceRefSchema.nullable().describe('null when the Project is in the Organization-wide Public area'),
    folder: ResourceRefSchema.nullable(),
    disabled: z.boolean(),
    timezone: z.string(),
    agentStatus: z.enum(AgentStatus),
    lastPromptAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    environments: z.array(EnvironmentSchema).describe('Development first, then by creation time'),
  })
  .meta({ id: 'Project' });

export const ProjectPageSchema = pageSchema(ProjectSchema, 'ProjectPage');

export const ProjectListQuerySchema = z.strictObject({
  ...CursorPageQueryShape,
  workspaceId: z.string().optional().describe('Only Projects in this workspace'),
  agentId: z.string().optional().describe('Only Projects running this Agent'),
});

export const ProjectPathSchema = z.strictObject({ id: z.string().min(1) });

const OFFSET_TIMEZONE = /^[+-]/;

function isIanaTimezone(value: string): boolean {
  if (OFFSET_TIMEZONE.test(value)) return false;
  try {
    return Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone.length > 0;
  } catch {
    return false;
  }
}

export const CreateProjectSchema = z
  .strictObject({
    title: z.string().trim().min(1).max(30),
    agentId: z.string().min(1).describe('Agent profile the Project runs, from GET /agents'),
    description: z.string().trim().max(100).optional(),
    workspaceId: z
      .string()
      .min(1)
      .optional()
      .describe('Workspace to create the Project in; omit to use the default placement'),
    folderId: z.string().min(1).optional().describe('Folder inside the target workspace'),
    timezone: z
      .string()
      .min(1)
      .refine(isIanaTimezone, 'Not an IANA time zone name')
      .optional()
      .describe('IANA time zone name, defaults to UTC'),
  })
  .meta({
    id: 'CreateProject',
    examples: [
      { title: 'Public API Live Check', agentId: 'e70306b2-e32e-4d7f-b812-cfed76d6e693' },
      {
        title: 'Weekly report',
        agentId: 'e70306b2-e32e-4d7f-b812-cfed76d6e693',
        description: 'Builds the Monday revenue summary',
        timezone: 'Europe/Kyiv',
      },
    ],
  });

export type OpencodeDescriptorDto = z.infer<typeof OpencodeDescriptorSchema>;
export type ConnectionDto = z.infer<typeof ConnectionSchema>;
export type EnvironmentPath = z.infer<typeof EnvironmentPathSchema>;
export type EnvironmentDto = z.infer<typeof EnvironmentSchema>;
export type ProjectDto = z.infer<typeof ProjectSchema>;
export type ProjectPageDto = z.infer<typeof ProjectPageSchema>;
export type ProjectListQuery = z.infer<typeof ProjectListQuerySchema>;
export type CreateProject = z.infer<typeof CreateProjectSchema>;
export type ProjectPath = z.infer<typeof ProjectPathSchema>;
