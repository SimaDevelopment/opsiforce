import {
  openApiRouteRequest,
  ServiceError,
  type OpenApiRoute,
  type OperationContext,
} from '@opsiforce/external-service-sdk';

import type { Manifest } from '../service.types.ts';

const problemTypePrefix = 'urn:opsiforce:error:';

function refusalOf(status: number, body: Record<string, unknown>): ServiceError {
  const { type, title, status: _status, detail, instance: _instance, ...extensions } = body;
  const code =
    typeof type === 'string' && type.startsWith(problemTypePrefix)
      ? type.slice(problemTypePrefix.length)
      : 'unexpected';
  return new ServiceError({
    status,
    code,
    detail: typeof detail === 'string' ? detail : undefined,
    title: typeof title === 'string' ? title : undefined,
    extensions,
  });
}

export async function callPublicApi(
  route: OpenApiRoute | undefined,
  input: Record<string, unknown>,
  ctx: OperationContext<Manifest>
): Promise<unknown> {
  if (!route || !ctx.platformApi) {
    throw new ServiceError({
      status: 502,
      code: 'platform-api-unreachable',
      detail: 'The platform API is not reachable from this call.',
    });
  }
  const request = openApiRouteRequest(route, input);
  const response = await fetch(`${ctx.platformApi.url}${request.path}`, {
    method: request.method,
    headers: {
      authorization: `Bearer ${ctx.platformApi.token.reveal()}`,
      ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: request.body === undefined ? undefined : JSON.stringify(request.body),
    signal: ctx.signal,
  });
  const text = await response.text();
  const body = text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
  if (!response.ok) throw refusalOf(response.status, body);
  return body;
}
