import type { SkillFlags } from '../../store/gate';
import type { GateResponse, SkillFileResponse, SkillSummary } from '../../store/skill.types';
import type { SkillDto, SkillFileDto, SkillValidationDto } from './skills.schema';

function toFlags(flags: SkillFlags): SkillValidationDto['flags'] {
  return { hasExecutables: flags.has_executables };
}

export const SkillMapper = {
  toDto: (skill: SkillSummary): SkillDto => ({
    id: skill.id,
    name: skill.name,
    displayName: skill.displayName,
    description: skill.description,
    origin: skill.origin === 'built_in' ? 'built_in' : 'custom',
    visibility: skill.visibility === 'public' ? 'public' : 'private',
    archived: skill.archived,
    available: skill.available,
    createdBy: skill.createdBy,
    createdInChatProjectId: skill.createdInChatProjectId,
    usedByAgentCount: skill.usedByAgentCount,
    latestVersion: skill.latestVersion
      ? {
          version: skill.latestVersion.version,
          description: skill.latestVersion.description,
          flags: toFlags(skill.latestVersion.flags),
        }
      : null,
    createdAt: skill.createdAt.toISOString(),
    updatedAt: skill.updatedAt.toISOString(),
  }),

  toFileDto: (file: SkillFileResponse): SkillFileDto => ({
    path: file.path,
    content: file.content,
    isBinary: file.isBinary,
    isExecutable: file.isExecutable,
    size: file.size,
  }),

  toValidationDto: (gate: GateResponse): SkillValidationDto => ({
    valid: gate.valid,
    errors: gate.errors,
    lints: gate.lints,
    flags: toFlags(gate.flags),
  }),

  toFlags,
};
