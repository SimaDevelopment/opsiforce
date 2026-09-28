import { ConflictException, InternalServerErrorException, UnprocessableEntityException } from '@nestjs/common';
import type { TemplateRefusal } from './template-source';

export function templateRefused(refusals: TemplateRefusal[]): UnprocessableEntityException {
  return new UnprocessableEntityException({
    code: 'template_refused',
    message: `The Template holds ${refusals.length} path${refusals.length === 1 ? '' : 's'} a save refuses; nothing was saved`,
    refusals,
  });
}

export function templateChanged(): ConflictException {
  return new ConflictException({
    code: 'template_changed',
    message: 'template/ changed while it was being saved; stop whatever writes to it and save again',
  });
}

export function templateDamaged(): ConflictException {
  return new ConflictException({
    code: 'template_damaged',
    message:
      "The Development Template points at a version that is missing; save it again from the Agent's Builder chat",
  });
}

export function templateVersionMissing(
  agentId: string,
  environmentId: string,
  hash: string
): InternalServerErrorException {
  return new InternalServerErrorException({
    code: 'template_version_missing',
    message: `Agent ${agentId}'s Template on Environment ${environmentId} links to version ${hash}, which is missing`,
  });
}

export function templateCopyMismatch(
  agentId: string,
  environmentId: string,
  retries: number
): InternalServerErrorException {
  return new InternalServerErrorException({
    code: 'template_copy_mismatch',
    message: `Agent ${agentId}'s Template on Environment ${environmentId} did not copy intact after ${retries} retries`,
  });
}
