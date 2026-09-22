import {
  applyDecorators,
  Controller,
  HttpCode,
  HttpStatus,
  SerializeOptions,
  StandardSchemaSerializerInterceptor,
  UseGuards,
  UseInterceptors,
  UsePipes,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiProduces,
  ApiResponse,
  type ApiResponseOptions,
} from '@nestjs/swagger';
import type { z } from 'zod';
import { ResolvesOwnTenant } from '../tenant/tenant.decorator';
import { ChatEventsInterceptor } from './auth/chat-events.interceptor';
import { PublicApiGuard } from './auth/public-api.guard';
import {
  ERROR_TYPES,
  errorTypeUri,
  RETRY_AFTER_HEADER,
  retryAfterSecondsOf,
  type ErrorSlug,
} from './errors/error-types';
import { ERROR_MEDIA_TYPE } from './errors/error.schema';
import { PublicApiValidationPipe } from './validation/public-api-validation.pipe';

export const ERROR_COMPONENT_REF = '#/components/schemas/ApiError';
export const EVENT_STREAM_MEDIA_TYPE = 'text/event-stream';

export function PublicApiController(path: string): ClassDecorator {
  return applyDecorators(
    Controller({ path, version: '1' }),
    ApiBearerAuth(),
    ResolvesOwnTenant(),
    UseGuards(PublicApiGuard),
    UsePipes(PublicApiValidationPipe),
    UseInterceptors(StandardSchemaSerializerInterceptor, ChatEventsInterceptor)
  );
}

export function PublicResponse(status: number, schema: z.ZodType): MethodDecorator {
  return applyDecorators(
    HttpCode(status),
    SerializeOptions({ schema }),
    ApiResponse({ status, standardSchema: schema })
  );
}

export function PublicNoContentResponse(description: string): MethodDecorator {
  return applyDecorators(HttpCode(HttpStatus.NO_CONTENT), ApiNoContentResponse({ description }));
}

export function PublicEventStreamResponse(description: string, schema: z.ZodType): MethodDecorator {
  return applyDecorators(
    ApiProduces(EVENT_STREAM_MEDIA_TYPE),
    ApiResponse({ status: HttpStatus.OK, description, standardSchema: schema })
  );
}

export function PublicApiErrors(...slugs: ErrorSlug[]): MethodDecorator {
  const byStatus = new Map<number, ErrorSlug[]>();
  for (const slug of slugs) {
    const { status } = ERROR_TYPES[slug];
    byStatus.set(status, [...(byStatus.get(status) ?? []), slug]);
  }
  const responses = [...byStatus.entries()].map(([status, statusSlugs]) =>
    ApiResponse({
      status,
      description: statusSlugs.map((slug) => ERROR_TYPES[slug].title).join(' / '),
      ...retryAfterHeaderDoc(statusSlugs),
      content: {
        [ERROR_MEDIA_TYPE]: {
          schema: {
            allOf: [
              { $ref: ERROR_COMPONENT_REF },
              { type: 'object', properties: { type: { type: 'string', enum: statusSlugs.map(errorTypeUri) } } },
            ],
          },
        },
      },
    })
  );
  return applyDecorators(...responses);
}

function retryAfterHeaderDoc(slugs: ErrorSlug[]): Pick<ApiResponseOptions, 'headers'> {
  const seconds = slugs.map(retryAfterSecondsOf).find((value) => value !== null);
  if (seconds === undefined) return {};

  return {
    headers: {
      [RETRY_AFTER_HEADER]: {
        description: 'Seconds to wait before retrying',
        schema: { type: 'integer', example: seconds },
      },
    },
  };
}
