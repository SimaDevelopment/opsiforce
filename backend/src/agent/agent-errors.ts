import { ConflictException } from '@nestjs/common';

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
