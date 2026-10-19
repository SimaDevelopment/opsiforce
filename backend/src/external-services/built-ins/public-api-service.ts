import { randomUUID } from 'node:crypto';
import { Injectable, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA, VERSION_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, HttpAdapterHost } from '@nestjs/core';
import {
  allowAll,
  defineService,
  route,
  type DefinedService,
  type Refusal,
  type RefusalOutcome,
  type Route,
  type RouteCheck,
  type RouteContext,
} from '@opsiforce/external-service-sdk';
import { callerIdentityHeader, mintCallerIdentity, nullBodyStatuses } from '@opsiforce/external-service-sdk/server';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { SERVICE_ROUTE_KEY, type ServiceRouteOptions } from '../../public-api/auth/service-route.decorator';
import { ERROR_TYPES, errorTypeUri, type ErrorSlug } from '../../public-api/errors/error-types';
import { ERROR_MEDIA_TYPE } from '../../public-api/errors/error.schema';
import { SecretSealer } from '../../sealing/secret-sealer';
import type { PublicApiSwitch } from '../configuration/public-api-settings';
import { builtInCallerKey } from './built-in-caller-key';

export const PUBLIC_API_SERVICE = 'public-api';

export const PUBLIC_API_COUNTERS = {
  projects_created: { label: 'Projects created', description: 'Projects created through the Public API' },
  skill_versions_published: {
    label: 'Skill Versions published',
    description: 'Skill Versions published through the Public API, a new Skill or a duplicate included',
  },
} as const;

export type PublicApiCounter = keyof typeof PUBLIC_API_COUNTERS;

export const WHO_CHANGES_PUBLIC_API_SETTINGS =
  "Someone who can configure this Project's External Services can change it.";

const FORWARDED_HEADERS = new Set(['content-type', 'accept', 'user-agent', 'if-match', 'if-none-match']);

const ANSWER_HEADERS_DROPPED = new Set(['content-length', 'transfer-encoding', 'connection', 'keep-alive']);

const REFUSAL_SLUGS: Record<RefusalOutcome, ErrorSlug> = {
  'not allowed': 'permission-denied',
  'not connected': 'permission-denied',
  incomplete: 'permission-denied',
  'not supported': 'route-not-found',
  failed: 'unexpected',
  unidentified: 'unauthenticated',
};

const SETTING_REFUSALS: ReadonlySet<RefusalOutcome> = new Set(['not allowed', 'not connected', 'incomplete']);

export function publicApiRefusal(refusal: Refusal): Response {
  const slug = REFUSAL_SLUGS[refusal.outcome];
  const detail = SETTING_REFUSALS.has(refusal.outcome)
    ? `${refusal.message} ${WHO_CHANGES_PUBLIC_API_SETTINGS}`
    : refusal.message;
  return new Response(
    JSON.stringify({
      type: errorTypeUri(slug),
      title: ERROR_TYPES[slug].title,
      status: refusal.status,
      detail,
      instance: `urn:uuid:${randomUUID()}`,
    }),
    { status: refusal.status, headers: { 'content-type': `${ERROR_MEDIA_TYPE}; charset=utf-8` } }
  );
}

function allowedByCheck(summary: string, allowedBy: readonly PublicApiSwitch[]): RouteCheck {
  if (allowedBy.length === 0) return allowAll;
  return (_request, ctx) => {
    const off = allowedBy.find((setting) => ctx.projectConfiguration[setting] !== true);
    return off === undefined
      ? ctx.allow()
      : ctx.notAllowed({ setting: off, message: `${summary}: this Project's configuration does not allow it` });
  };
}

function pathSegments(path: unknown): string[] {
  const value = Array.isArray(path) ? path[0] : path;
  return typeof value === 'string' ? value.split('/').filter((segment) => segment !== '') : [];
}

function patternOf(controller: object, handler: object): string {
  const version = Reflect.getMetadata(VERSION_METADATA, controller) as unknown;
  if (typeof version !== 'string') {
    throw new Error(`${(controller as { name?: string }).name} carries @ServiceRoute outside /api/v<n>`);
  }
  const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod];
  const segments = [
    'api',
    `v${version}`,
    ...pathSegments(Reflect.getMetadata(PATH_METADATA, controller)),
    ...pathSegments(Reflect.getMetadata(PATH_METADATA, handler)),
  ];
  return `${method} /${segments.join('/')}`;
}

export interface DecoratedServiceRoute extends ServiceRouteOptions {
  pattern: string;
}

export function serviceRoutesOf(controller: { prototype: object }): DecoratedServiceRoute[] {
  const prototype = controller.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(prototype).flatMap((name) => {
    const handler = name === 'constructor' ? undefined : prototype[name];
    if (typeof handler !== 'function') return [];
    const decorated = Reflect.getMetadata(SERVICE_ROUTE_KEY, handler) as ServiceRouteOptions | undefined;
    return decorated ? [{ ...decorated, pattern: patternOf(controller, handler) }] : [];
  });
}

function bySpecificity(left: Route, right: Route): number {
  const length = Math.min(left.pattern.segments.length, right.pattern.segments.length);
  for (let index = 0; index < length; index += 1) {
    const leftParam = left.pattern.segments[index]?.kind === 'literal' ? 0 : 1;
    const rightParam = right.pattern.segments[index]?.kind === 'literal' ? 0 : 1;
    if (leftParam !== rightParam) return leftParam - rightParam;
  }
  return 0;
}

function answerHeaders(headers: Record<string, string | string[] | number | undefined>): Headers {
  const answer = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || ANSWER_HEADERS_DROPPED.has(name)) continue;
    for (const entry of Array.isArray(value) ? value : [value]) answer.append(name, String(entry));
  }
  return answer;
}

@Injectable()
export class PublicApiService {
  private defined: DefinedService | null = null;

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly sealer: SecretSealer
  ) {}

  definedFrom(folder: DefinedService): DefinedService {
    this.defined ??= defineService({
      ...folder.definition,
      routes: this.routes(),
      counters: PUBLIC_API_COUNTERS,
      refusal: publicApiRefusal,
    });
    return this.defined;
  }

  private routes(): Route[] {
    return this.discovery
      .getControllers()
      .flatMap(({ metatype }) => (metatype ? serviceRoutesOf(metatype) : []))
      .map((decorated) =>
        route(decorated.pattern, {
          summary: decorated.summary,
          allowedBy: decorated.allowedBy,
          check: allowedByCheck(decorated.summary, decorated.allowedBy),
          handle: (request, ctx) => this.forward(request, ctx, decorated.counts),
        })
      )
      .toSorted(bySpecificity);
  }

  private async forward(request: Request, ctx: RouteContext, counts: PublicApiCounter | undefined): Promise<Response> {
    const url = new URL(request.url);
    const headers: Record<string, string> = Object.fromEntries(
      [...request.headers].filter(([name]) => FORWARDED_HEADERS.has(name))
    );
    headers[callerIdentityHeader] = mintCallerIdentity(ctx.caller, builtInCallerKey(this.sealer, PUBLIC_API_SERVICE));
    const payload = request.body === null ? null : Buffer.from(await request.arrayBuffer());
    const answer = await this.fastify().inject({
      method: request.method as InjectOptions['method'],
      url: `${url.pathname}${url.search}`,
      headers,
      ...(payload === null || payload.byteLength === 0 ? {} : { payload }),
    });
    if (counts !== undefined && answer.statusCode >= 200 && answer.statusCode < 300) ctx.count(counts);
    return new Response(nullBodyStatuses.has(answer.statusCode) ? null : new Uint8Array(answer.rawPayload), {
      status: answer.statusCode,
      headers: answerHeaders(answer.headers),
    });
  }

  private fastify(): FastifyInstance {
    return this.httpAdapterHost.httpAdapter.getInstance<FastifyInstance>();
  }
}
