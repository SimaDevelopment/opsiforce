import { HttpException } from '@nestjs/common';
import type { GateFinding } from '../../store/gate';
import { Errors, PublicApiError } from './public-api-error';
import type { ValidationErrorItem } from './error.schema';

const PROBLEM_BY_CODE: Record<string, (message: string) => PublicApiError> = {
  name_unavailable: Errors.nameUnavailable,
  visibility_incoherent: Errors.visibilityIncoherent,
  skill_in_use: Errors.skillInUse,
  duplicate_skill_name: Errors.duplicateSkillName,
  model_unknown: Errors.modelUnknown,
  not_publishable: Errors.notPublishable,
};

interface CodedBody {
  code?: unknown;
  message?: unknown;
  errors?: unknown;
  lints?: unknown;
}

function bodyOf(exception: HttpException): CodedBody {
  const response = exception.getResponse();
  return typeof response === 'object' && response !== null ? (response as CodedBody) : {};
}

function messageOf(body: CodedBody, fallback: string): string {
  return typeof body.message === 'string' ? body.message : fallback;
}

function toItems(value: unknown): ValidationErrorItem[] {
  if (!Array.isArray(value)) return [];
  return (value as GateFinding[]).map((finding) => {
    const item: ValidationErrorItem = {
      detail: finding.message,
      pointer: '#/files',
      in: 'body',
      rule: finding.rule,
    };
    if (finding.file !== null) item.file = finding.file;
    if (finding.line !== null) item.line = finding.line;
    return item;
  });
}

function toPublicApiError(error: unknown): PublicApiError | null {
  if (!(error instanceof HttpException)) return null;

  const body = bodyOf(error);
  if (typeof body.code !== 'string') return null;

  if (body.code === 'validation_failed') {
    return Errors.validationFailed(
      messageOf(body, 'The submitted skill did not pass validation'),
      toItems(body.errors),
      toItems(body.lints)
    );
  }

  const build = PROBLEM_BY_CODE[body.code];
  return build ? build(messageOf(body, error.message)) : null;
}

export async function mappingStoreErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw toPublicApiError(error) ?? error;
  }
}
