import { HttpException } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { isPublicApiPath } from './public-api.paths';

export interface FastifyErrorLike extends Error {
  code: string;
  statusCode: number;
}

const JSON_MEDIA_TYPE = 'application/json';

export function isFastifyError(error: unknown): error is FastifyErrorLike {
  return error instanceof Error && error.name === 'FastifyError' && 'code' in error && 'statusCode' in error;
}

export class PublicApiFastifyAdapter extends FastifyAdapter {
  private emptyJsonBodyParserRegistered = false;

  override mapException(error: unknown): unknown {
    if (isFastifyError(error)) return new HttpException(error.message, error.statusCode, { cause: error });
    return error;
  }

  override registerParserMiddleware(prefix?: string, rawBody?: boolean): void {
    super.registerParserMiddleware(prefix, rawBody);
    if (this.emptyJsonBodyParserRegistered) return;
    this.emptyJsonBodyParserRegistered = true;

    const { bodyLimit, onProtoPoisoning, onConstructorPoisoning } = this.instance.initialConfig;
    const parseJson = this.instance.getDefaultJsonParser(
      onProtoPoisoning ?? 'error',
      onConstructorPoisoning ?? 'error'
    );

    this.instance.removeContentTypeParser(JSON_MEDIA_TYPE);
    this.useBodyParser(JSON_MEDIA_TYPE, Boolean(rawBody), { bodyLimit }, (request, body, done) => {
      if (body.length === 0 && isPublicApiPath(request.url)) {
        done(null, undefined);
        return;
      }
      parseJson(request, body.toString('utf8'), done);
    });
  }
}
