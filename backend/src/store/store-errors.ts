import { ConflictException, ForbiddenException, UnprocessableEntityException } from '@nestjs/common';
import type { GateFinding } from './gate';

export function nameUnavailable(name: string): ConflictException {
  return new ConflictException({ code: 'name_unavailable', message: `The name \`${name}\` is unavailable` });
}

export function validationFailed(errors: GateFinding[], lints: GateFinding[]): UnprocessableEntityException {
  return new UnprocessableEntityException({
    code: 'validation_failed',
    message: 'The submitted skill did not pass validation',
    errors,
    lints,
  });
}

export function notDisableable(message: string): ConflictException {
  return new ConflictException({ code: 'not_disableable', message });
}

export function skillInUse(agents: { id: string; displayName: string }[]): ConflictException {
  return new ConflictException({
    code: 'skill_in_use',
    message: 'The skill is still carried by an agent',
    agents,
  });
}

export function visibilityIncoherent(message: string): ForbiddenException {
  return new ForbiddenException({ code: 'visibility_incoherent', message });
}

export function outsideCallingProject(subject: string): ForbiddenException {
  return new ForbiddenException({
    code: 'outside_calling_project',
    message: `${subject} is neither this chat's subject nor created by its Project`,
  });
}

export function serviceSkillUnavailable(name: string): ConflictException {
  return new ConflictException({
    code: 'service_unavailable',
    message: `Skill \`${name}\` can't be added while its External Service isn't available`,
  });
}

export function serviceSkillReadOnly(name: string): ForbiddenException {
  return new ForbiddenException({
    code: 'service_skill_read_only',
    message: `Skill \`${name}\` comes from its External Service: change the service's SKILL.md and publish it`,
  });
}

export function skillRetired(name: string): ConflictException {
  return new ConflictException({
    code: 'skill_retired',
    message: `Skill \`${name}\` is retired: the agent image no longer ships it`,
  });
}
