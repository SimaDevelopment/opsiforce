import type { OpenAPIObject } from '@nestjs/swagger';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { expect } from 'vitest';
import { ERROR_TYPES, ERROR_TYPE_PREFIX, type ErrorSlug } from '../../../src/public-api/errors/error-types';
import { ERROR_MEDIA_TYPE } from '../../../src/public-api/errors/error.schema';
import { OPENAPI_JSON_PATH } from '../../../src/public-api/public-api.docs';
import { PUBLIC_API_PREFIX } from '../../../src/public-api/public-api.paths';
import { PROBE_PATH } from './probe-api';

const SCAFFOLDING_PREFIX = `${PUBLIC_API_PREFIX}/${PROBE_PATH}/`;

/** Raised by the guards, the pipe and the filter on any route, so no operation has to declare them. */
const AMBIENT_SLUGS = new Set<ErrorSlug>([
  'validation-error',
  'unauthenticated',
  'organization-required',
  'organization-forbidden',
  'permission-denied',
  'route-not-found',
  'unexpected',
]);

export interface ObservedProblem {
  method: string;
  url: string;
  type: string;
}

interface DocumentOperation {
  responses?: Record<string, { content?: Record<string, { schema?: { allOf?: [unknown, ResponseType] } }> }>;
}

interface ResponseType {
  properties?: { type?: { enum?: string[] } };
}

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

function slugOfTypeUri(type: string): ErrorSlug | null {
  const slug = type.replace(ERROR_TYPE_PREFIX, '');
  return slug in ERROR_TYPES ? (slug as ErrorSlug) : null;
}

function slugsOf(operation: DocumentOperation): Set<ErrorSlug> {
  const slugs = new Set<ErrorSlug>();
  for (const response of Object.values(operation.responses ?? {})) {
    for (const type of response.content?.[ERROR_MEDIA_TYPE]?.schema?.allOf?.[1].properties?.type?.enum ?? []) {
      const slug = slugOfTypeUri(type);
      if (slug) slugs.add(slug);
    }
  }
  return slugs;
}

/** Keyed the way an observed response is: `POST /api/v1/skills`. */
function declaredSlugsByRoute(document: OpenAPIObject): Map<string, Set<ErrorSlug>> {
  const paths = document.paths as Record<string, Record<string, DocumentOperation>>;
  const declared = new Map<string, Set<ErrorSlug>>();
  for (const [path, operations] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(operations)) {
      if (HTTP_METHODS.has(method)) declared.set(`${method.toUpperCase()} ${path}`, slugsOf(operation));
    }
  }
  return declared;
}

/** Fastify names path parameters `:id`; the document names them `{id}`. */
function toDocumentPath(url: string): string {
  return url.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

/** Never a declared `type`, so a body the hook could not read fails the file rather than vanishing. */
const UNREADABLE = 'an unreadable problem+json body';

function typeOf(payload: unknown): string {
  if (typeof payload !== 'string') return UNREADABLE;
  try {
    const { type } = JSON.parse(payload) as { type?: unknown };
    return typeof type === 'string' ? type : UNREADABLE;
  } catch {
    return UNREADABLE;
  }
}

export function observedProblemOf(
  method: string,
  routeUrl: string | undefined,
  requestUrl: string,
  payload: unknown
): ObservedProblem {
  return { method, url: toDocumentPath(routeUrl ?? requestUrl.split('?')[0]), type: typeOf(payload) };
}

export async function assertProblemsDeclared(
  app: NestFastifyApplication,
  problems: readonly ObservedProblem[]
): Promise<void> {
  const unexempt = problems.filter(({ url, type }) => {
    const slug = slugOfTypeUri(type);
    return !url.startsWith(SCAFFOLDING_PREFIX) && !(slug && AMBIENT_SLUGS.has(slug));
  });
  if (unexempt.length === 0) return;

  const res = await app.inject({ method: 'GET', url: OPENAPI_JSON_PATH });
  const declared = declaredSlugsByRoute(res.json<OpenAPIObject>());

  const failures = new Set<string>();
  for (const { method, url, type } of unexempt) {
    const route = `${method} ${url}`;
    const slugs = declared.get(route);
    const slug = slugOfTypeUri(type);
    if (slugs === undefined) failures.add(`${route} answered ${type} but the document publishes no such operation`);
    else if (!slug || !slugs.has(slug)) failures.add(`${route} answered ${type} without declaring it`);
  }

  if (failures.size > 0) {
    expect.fail(`the app answered Problems their operation does not declare:\n${[...failures].toSorted().join('\n')}`);
  }
}
