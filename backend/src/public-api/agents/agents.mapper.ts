import type { AgentDetail, AgentProfileSkillResponse } from '../../agent/agent.types';
import { SkillMapper } from '../skills/skills.mapper';
import type { AgentRow } from './agents.repository';
import type { AgentDetailDto, AgentDto, AgentSkillDto } from './agents.schema';

function toSkillDto(skill: AgentProfileSkillResponse): AgentSkillDto {
  return {
    skillId: skill.skillId,
    name: skill.name,
    displayName: skill.displayName,
    pinnedVersion: skill.pinnedVersion,
    latestVersion: skill.latestVersion,
    updateAvailable: skill.updateAvailable,
    visibility: skill.visibility === 'public' ? 'public' : 'private',
    flags: SkillMapper.toFlags(skill.flags),
  };
}

export const AgentMapper = {
  toDto: ({ id, name, displayName, description }: AgentRow): AgentDto => ({ id, name, displayName, description }),

  toSkillDto,

  toDetailDto: (agent: AgentDetail): AgentDetailDto => ({
    id: agent.id,
    name: agent.name,
    displayName: agent.displayName,
    description: agent.description,
    origin: agent.origin === 'built_in' ? 'built_in' : 'custom',
    visibility: agent.visibility === 'public' ? 'public' : 'private',
    disabled: agent.disabled,
    createdBy: agent.createdBy,
    imageOwned: agent.imageOwned,
    live: agent.live,
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
    settings: {
      defaultEnvironmentId: agent.settings.defaultEnvironmentId,
      platformApi: agent.settings.platformApi,
    },
    profiles: agent.profiles.map((profile) => ({
      environmentId: profile.environmentId,
      promptBody: profile.promptBody,
      model: profile.model,
      variant: profile.variant,
      updatedAt: profile.updatedAt === null ? null : profile.updatedAt.toISOString(),
      skills: profile.skills === null ? null : profile.skills.map(toSkillDto),
    })),
    projectCount: agent.projectCount,
  }),
};
