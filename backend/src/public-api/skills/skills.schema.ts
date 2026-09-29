import { z } from 'zod';

export const SKILL_LIST_FILTERS = ['all', 'mine', 'built_in', 'custom', 'private', 'disabled'] as const;

export const SkillFlagsSchema = z
  .strictObject({
    hasExecutables: z.boolean().describe('Any file carries the executable bit or lives under scripts/'),
  })
  .meta({ id: 'SkillFlags' });

export const SkillVersionRefSchema = z
  .strictObject({
    version: z.int().describe('The integer Version, minted in order from 1'),
    description: z.string().nullable(),
    flags: SkillFlagsSchema,
  })
  .meta({ id: 'SkillVersionRef' });

export const SkillSchema = z
  .strictObject({
    id: z.string(),
    name: z.string().describe('Immutable kebab-case name; the directory opencode loads it under'),
    displayName: z.string().nullable(),
    description: z.string().nullable().describe('The SKILL.md frontmatter description of the latest Version'),
    origin: z.enum(['built_in', 'custom']),
    visibility: z.enum(['private', 'public']),
    disabled: z.boolean(),
    available: z
      .boolean()
      .describe('False for a Built-in Skill the running agent image no longer ships; its rows survive'),
    createdBy: z.string().nullable(),
    builderChatId: z
      .string()
      .nullable()
      .describe('The one Builder chat that authors it, once someone has opened the Builder on it'),
    usedByAgentCount: z.int(),
    latestVersion: SkillVersionRefSchema.nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'Skill' });

export const SkillListSchema = z.strictObject({ items: z.array(SkillSchema) }).meta({ id: 'SkillList' });

export const SkillFileSchema = z
  .strictObject({
    path: z.string().describe('Path relative to the Skill root'),
    content: z.string().describe('UTF-8 text, or base64 when isBinary is true'),
    isBinary: z.boolean(),
    isExecutable: z.boolean(),
    size: z.int().describe('Size in bytes of the stored file'),
  })
  .meta({ id: 'SkillFile' });

export const SkillFileListSchema = z.strictObject({ items: z.array(SkillFileSchema) }).meta({ id: 'SkillFileList' });

export const GateFindingSchema = z
  .strictObject({
    rule: z.string().describe('Stable rule id, safe to branch on'),
    message: z.string(),
    file: z.string().nullable(),
    line: z.int().nullable(),
  })
  .meta({ id: 'GateFinding' });

export const SkillValidationSchema = z
  .strictObject({
    valid: z.boolean().describe('True when errors is empty; lints never block a write'),
    errors: z.array(GateFindingSchema),
    lints: z.array(GateFindingSchema),
    flags: SkillFlagsSchema,
  })
  .meta({ id: 'SkillValidation' });

export const SkillFileInputSchema = z
  .strictObject({
    path: z.string().min(1).describe('Path relative to the Skill root; no leading slash and no ..'),
    content: z.string().describe('UTF-8 text, or base64 when isBinary is true'),
    isBinary: z.boolean().optional().describe('Decode content as base64'),
    executable: z.boolean().optional(),
  })
  .meta({ id: 'SkillFileInput' });

const filesField = z
  .array(SkillFileInputSchema)
  .min(1)
  .describe('The whole file tree, SKILL.md included; a submission replaces nothing, it mints a Version');

export const SkillListQuerySchema = z.strictObject({
  filter: z.enum(SKILL_LIST_FILTERS).optional().describe('Defaults to all; disabled needs can_manage_skills'),
  q: z.string().optional().describe('Substring match on name, display name and description'),
});

export const SkillPathSchema = z.strictObject({ id: z.string().min(1) });

export const SkillVersionPathSchema = z.strictObject({
  id: z.string().min(1),
  version: z.coerce.number().int().min(1),
});

export const CreateSkillSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(64).describe('Kebab-case, equal to the SKILL.md frontmatter name'),
    displayName: z.string().trim().min(1).optional(),
    files: filesField,
  })
  .meta({
    id: 'CreateSkill',
    examples: [
      {
        name: 'release-notes',
        files: [
          {
            path: 'SKILL.md',
            content:
              '---\nname: release-notes\ndescription: Use this skill when writing release notes from merged pull requests, including grouping and tone.\n---\n\n# Release notes\n',
          },
        ],
      },
    ],
  });

export const CreateSkillVersionSchema = z.strictObject({ files: filesField }).meta({ id: 'CreateSkillVersion' });

export const ValidateSkillSchema = z
  .strictObject({
    name: z.string().trim().min(1).optional().describe('Check the frontmatter name against this one'),
    files: filesField,
  })
  .meta({ id: 'ValidateSkill' });

export const UpdateSkillSchema = z
  .strictObject({
    displayName: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .nullable()
      .describe('The name people see; null falls back to `name`, which never changes'),
  })
  .meta({ id: 'UpdateSkill', examples: [{ displayName: 'Release Notes' }] });

export const DuplicateSkillSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(64).describe('Name of the new private Skill'),
    displayName: z.string().trim().min(1).optional(),
  })
  .meta({ id: 'DuplicateSkill' });

export type SkillDto = z.infer<typeof SkillSchema>;
export type SkillListDto = z.infer<typeof SkillListSchema>;
export type SkillFileDto = z.infer<typeof SkillFileSchema>;
export type SkillFileListDto = z.infer<typeof SkillFileListSchema>;
export type SkillValidationDto = z.infer<typeof SkillValidationSchema>;
export type SkillListQuery = z.infer<typeof SkillListQuerySchema>;
export type SkillPath = z.infer<typeof SkillPathSchema>;
export type SkillVersionPath = z.infer<typeof SkillVersionPathSchema>;
export type CreateSkill = z.infer<typeof CreateSkillSchema>;
export type CreateSkillVersion = z.infer<typeof CreateSkillVersionSchema>;
export type ValidateSkill = z.infer<typeof ValidateSkillSchema>;
export type UpdateSkill = z.infer<typeof UpdateSkillSchema>;
export type DuplicateSkill = z.infer<typeof DuplicateSkillSchema>;
