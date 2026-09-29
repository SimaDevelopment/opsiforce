import { z } from 'zod';
import { ERROR_SLUGS, errorTypeUri } from './error-types';

export const ERROR_MEDIA_TYPE = 'application/problem+json';

export const TenantRefSchema = z.object({ id: z.string(), name: z.string() }).meta({ id: 'TenantRef' });

export const ValidationErrorItemSchema = z
  .object({
    detail: z.string(),
    pointer: z.string(),
    in: z.enum(['body', 'query', 'path']),
    rule: z.string().optional().describe('The validation rule that rejected the request, when one is named'),
    file: z.string().optional().describe('The submitted file the item is about, for file-tree requests'),
    line: z.int().optional().describe('1-based line inside `file`, when the rule found one'),
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
    lints: z
      .array(ValidationErrorItemSchema)
      .optional()
      .describe('Warnings that did not block the request, recorded alongside it'),
    tenants: z.array(TenantRefSchema).optional(),
    permission: z.string().optional(),
    testProjectId: z
      .string()
      .optional()
      .describe("With `test-project-exists`: the id of the chat's one Test Project, to refresh instead of creating"),
  })
  .meta({ id: 'ApiError' });

export type ApiError = z.infer<typeof ApiErrorSchema>;
export type TenantRef = z.infer<typeof TenantRefSchema>;
export type ValidationErrorItem = z.infer<typeof ValidationErrorItemSchema>;
