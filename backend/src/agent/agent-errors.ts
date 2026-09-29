import { BadRequestException, ConflictException } from '@nestjs/common';

export type ModelPart = 'provider' | 'model' | 'variant';

export function modelUnknown(part: ModelPart, value: string): ConflictException {
  return new ConflictException({ code: 'model_unknown', message: `Unknown ${part} \`${value}\``, part, value });
}

export function notPublishable(message: string): ConflictException {
  return new ConflictException({ code: 'not_publishable', message });
}

export function lastBuiltInAgent(label: string): ConflictException {
  return new ConflictException({
    code: 'last_built_in_agent',
    message: `Keep at least one built-in agent enabled — new projects need one to start on. Enable another before disabling ${label}.`,
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
