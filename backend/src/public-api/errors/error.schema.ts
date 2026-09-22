import { z } from 'zod';
import { ERROR_SLUGS, errorTypeUri } from './error-types';

export const ERROR_MEDIA_TYPE = 'application/problem+json';

export const OrganizationRefSchema = z.object({ id: z.string(), name: z.string() }).meta({ id: 'OrganizationRef' });

export const ValidationErrorItemSchema = z
  .object({
    detail: z.string(),
    pointer: z.string(),
    in: z.enum(['body', 'query', 'path']),
  })
  .meta({ id: 'ValidationErrorItem' });

export const ApiErrorSchema = z
  .object({
    type: z.enum(ERROR_SLUGS.map(errorTypeUri)),
    title: z.string(),
    status: z.int().min(400).max(599),
    detail: z.string().optional(),
    instance: z.string().optional(),
    errors: z.array(ValidationErrorItemSchema).optional(),
    organizations: z.array(OrganizationRefSchema).optional(),
    permission: z.string().optional(),
  })
  .meta({ id: 'ApiError' });

export type ApiError = z.infer<typeof ApiErrorSchema>;
export type OrganizationRef = z.infer<typeof OrganizationRefSchema>;
export type ValidationErrorItem = z.infer<typeof ValidationErrorItemSchema>;
