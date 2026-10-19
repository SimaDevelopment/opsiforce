import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Perms } from '../permission/permission.constants';

export type ModelPart = 'provider' | 'model' | 'variant';

export function modelUnknown(part: ModelPart, value: string): ConflictException {
  return new ConflictException({ code: 'model_unknown', message: `Unknown ${part} \`${value}\``, part, value });
}

export function modelUnreachable(model: string): ConflictException {
  return new ConflictException({
    code: 'model_unreachable',
    message: `\`${model}\` is unavailable in your organization: no model provider of its format is on`,
    part: 'model',
    value: model,
  });
}

export function notPublishable(message: string): ConflictException {
  return new ConflictException({ code: 'not_publishable', message });
}

const LAST_AGENT_RULE =
  "Keep at least one agent enabled — new projects need one to start on. A private agent, or one with nothing published to its default environment, doesn't count.";

export function lastAgent(label: string): ConflictException {
  return new ConflictException({
    code: 'last_agent',
    message: `${LAST_AGENT_RULE} Enable another before disabling ${label}.`,
  });
}

export function lastAgentUnpublished(label: string): ConflictException {
  return new ConflictException({
    code: 'last_agent',
    message: `${LAST_AGENT_RULE} Publish ${label} to that environment first, or enable another agent.`,
  });
}

export function agentInUse(projectCount: number): ConflictException {
  return new ConflictException({
    code: 'agent_in_use',
    message: `The agent still has ${projectCount} project(s)`,
    projectCount,
  });
}

export function duplicateSkillName(name: string): ConflictException {
  return new ConflictException({
    code: 'duplicate_skill_name',
    message: `The agent already carries a skill named \`${name}\``,
    name,
  });
}

export function shippedSkillName(name: string): ConflictException {
  return new ConflictException({
    code: 'duplicate_skill_name',
    message: `The agent's image already ships a skill named \`${name}\``,
    name,
  });
}

export function environmentInUse(agents: { id: string; displayName: string }[]): ConflictException {
  return new ConflictException({
    code: 'environment_in_use',
    message: 'The environment is still referenced by an agent',
    agents,
  });
}

export function developmentNotDefault(): BadRequestException {
  return new BadRequestException({
    code: 'development_not_default',
    message: 'Development holds unpublished work, so new projects cannot start from it. Pick another environment.',
  });
}

export function notDuplicable(label: string): BadRequestException {
  return new BadRequestException({
    code: 'not_duplicable',
    message: `${label} authors Skills and Agents only inside a Builder chat, so it can't be duplicated`,
  });
}

export function notExportable(label: string): BadRequestException {
  return new BadRequestException({
    code: 'not_exportable',
    message: `${label} is a Built-in Agent, so it can't be exported; duplicate it and export the copy`,
  });
}

export function builtInKeepsProjectConfiguration(label: string): BadRequestException {
  return new BadRequestException({
    code: 'built_in_agent',
    message: `${label} is a Built-in Agent: its Projects keep their own External Service configuration`,
  });
}

export function serviceSettingsInvalid(problems: string[]): BadRequestException {
  return new BadRequestException({ code: 'bad_request', message: problems.join('; ') });
}

export function fieldSettingsNeedProjectPermission(skillName: string): ForbiddenException {
  return new ForbiddenException({
    code: 'missing_permission',
    permission: Perms.configureProjectExternalServices,
    message: `Setting the service settings of \`${skillName}\` needs the Configure project External Services permission (${Perms.configureProjectExternalServices})`,
  });
}

export function serviceSettingsUnavailable(skillName: string): ConflictException {
  return new ConflictException({
    code: 'service_unavailable',
    message: `The service settings of \`${skillName}\` can't be read or changed while its External Service isn't available`,
  });
}
