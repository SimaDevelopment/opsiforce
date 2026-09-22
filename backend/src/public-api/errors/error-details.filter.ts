import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { MissingPermissionException } from '../../permission/missing-permission.exception';
import { getUserIdHeader } from '../../permission/permission.utils';
import { TenantAccessDeniedException } from '../../tenant/tenant-access-denied.exception';
import { ValidationIssuesSignal } from '../validation/validation-issues.signal';
import { isPublicApiPath } from '../public-api.paths';
import { isFastifyError } from '../public-api-fastify.adapter';
import { retryAfterSecondsOf } from './error-types';
import { ERROR_MEDIA_TYPE } from './error.schema';
import { Errors, PublicApiError } from './public-api-error';

export const REQUEST_ID_HEADER = 'x-request-id';
const JSON_BODY_ERROR_CODES = new Set(['FST_ERR_CTP_INVALID_JSON_BODY', 'FST_ERR_CTP_EMPTY_JSON_BODY']);

function requestInstance(request: FastifyRequest): string {
  return `urn:uuid:${request.id}`;
}

function messageOf(exception: HttpException): string {
  const response = exception.getResponse();
  if (typeof response === 'string') return response;
  if (typeof response === 'object' && 'message' in response) {
    const { message } = response as { message: string | string[] };
    return Array.isArray(message) ? message.join('; ') : message;
  }
  return exception.message;
}

function describe(exception: unknown): string {
  if (exception instanceof Error) return exception.stack ?? exception.message;
  return String(exception);
}

@Catch()
export class ErrorDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ErrorDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    this.respond(exception, host);
  }

  respond(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    if (reply.sent) return;

    const publicError = this.translate(exception, request);
    const apiError = publicError.toApiError(requestInstance(request));
    if (apiError.status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      const cause = exception instanceof PublicApiError ? apiError.title : describe(exception);
      const message = `request ${request.id} failed with ${apiError.type}: ${cause}`;
      if (retryAfterSecondsOf(publicError.slug) === null) this.logger.error(message);
      else this.logger.warn(message);
    }

    void reply
      .status(apiError.status)
      .headers({ ...publicError.headers, [REQUEST_ID_HEADER]: String(request.id) })
      .header('content-type', `${ERROR_MEDIA_TYPE}; charset=utf-8`)
      .send(JSON.stringify(apiError));
  }

  private translate(exception: unknown, request: FastifyRequest): PublicApiError {
    if (exception instanceof PublicApiError) return exception;
    if (exception instanceof ValidationIssuesSignal) return Errors.validationError(exception.toErrorItems());
    if (exception instanceof TenantAccessDeniedException) {
      return getUserIdHeader(request) ? Errors.organizationForbidden() : Errors.unauthenticated();
    }
    if (exception instanceof MissingPermissionException) return Errors.permissionDenied(exception.permission);
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      if (isFastifyError(exception.cause) && JSON_BODY_ERROR_CODES.has(exception.cause.code)) {
        return Errors.validationError([{ detail: exception.cause.message, pointer: '#', in: 'body' }]);
      }
      if (status === HttpStatus.NOT_FOUND && !request.routeOptions.url) return Errors.routeNotFound();
      if (status >= HttpStatus.INTERNAL_SERVER_ERROR) return Errors.unexpected();
      return Errors.fromForeignStatus(status, messageOf(exception));
    }
    return Errors.unexpected();
  }
}

@Catch()
export class PublicApiPrefixFilter extends BaseExceptionFilter {
  private readonly errorFilter = new ErrorDetailsFilter();
  private readonly fallback = super.catch.bind(this);

  override catch(exception: unknown, host: ArgumentsHost): void {
    const request = host.switchToHttp().getRequest<FastifyRequest>();
    if (isPublicApiPath(request.url)) {
      this.errorFilter.respond(exception, host);
      return;
    }
    this.fallback(exception, host);
  }
}
