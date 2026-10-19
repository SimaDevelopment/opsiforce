import type { CallerIdentity } from './caller-identity.ts';
import type { FormValues } from './form-levels.ts';
import { checkServiceManifest } from './check-manifest.ts';
import { computeManifestHash } from './manifest-hash.ts';
import type { ServiceManifest } from './manifest.ts';
import type { RefusalOverride, Verdict } from './refusals.ts';
import { parseRoutePattern, type RoutePattern } from './route-patterns.ts';
import type { Secret } from './secret.ts';
import type { AtomicServiceState } from './service-state.ts';

export interface ServiceTypes {
  serviceConfiguration: object;
  projectConfiguration: object;
  settings: string;
  events: string;
}

export interface AnyServiceTypes extends ServiceTypes {
  serviceConfiguration: FormValues;
  projectConfiguration: FormValues;
}

export interface Configurations<Types extends ServiceTypes = AnyServiceTypes> {
  serviceConfiguration: Types['serviceConfiguration'];
  projectConfiguration: Types['projectConfiguration'] | null;
}

export interface ProjectConfigurationEntry<Types extends ServiceTypes = AnyServiceTypes> {
  projectId: string;
  projectEnvironmentId: string;
  projectConfiguration: Types['projectConfiguration'];
}

export interface DeliveredEventFile {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface DeliveredEvent<Types extends ServiceTypes = AnyServiceTypes> {
  type: Types['events'];
  key: string;
  occurredAt: string;
  data: Record<string, unknown>;
  files?: DeliveredEventFile[];
}

export type DeliveryResultKind = 'stored' | 'duplicate' | 'not-connected' | 'over-cap';

export interface DeliveryResult {
  projectEnvironmentId: string;
  result: DeliveryResultKind;
}

export const upstreamLookups: unique symbol = Symbol('opsiforce.upstream-lookups');

export type UpstreamLookup = (
  upstream: Upstream<never>,
  path: string,
  init: RequestInit | undefined
) => Promise<Response>;

export interface LookupSource {
  readonly [upstreamLookups]?: UpstreamLookup;
}

export interface ServiceHandle<Types extends ServiceTypes = AnyServiceTypes> extends LookupSource {
  readonly state: AtomicServiceState;
  readonly webhookUrl: string;
  configuration(): Promise<Types['serviceConfiguration']>;
  projectConfigurations(): Promise<ProjectConfigurationEntry<Types>[]>;
  deliver(event: DeliveredEvent<Types>, options: { to: readonly string[] }): Promise<DeliveryResult[]>;
  count(name: string, n: number, options?: { projectEnvironment?: string }): void;
}

export interface RouteContext<Types extends ServiceTypes = AnyServiceTypes> extends LookupSource {
  readonly caller: CallerIdentity;
  readonly params: Readonly<Record<string, string>>;
  readonly projectConfiguration: Types['projectConfiguration'];
  readonly serviceConfiguration: Types['serviceConfiguration'];
  readonly missingServiceFields: readonly string[];
  readonly state: AtomicServiceState;
  readonly service: ServiceHandle<Types>;
  count(name: string, n?: number): void;
  note(fields: Record<string, unknown>): void;
  allow(): Verdict;
  notAllowed(refusal: { setting?: Types['settings']; message: string }): Verdict;
  notSupported(message?: string): Verdict;
}

export type Awaitable<Value> = Value | Promise<Value>;

export type FormName = 'serviceForm' | 'projectForm';

export interface OptionItem {
  value: string;
  label: string;
  description?: string;
}

export type MessageLevel = 'info' | 'success' | 'warning' | 'error';

export interface InfoResult {
  text: string;
  level?: MessageLevel;
}

export type ButtonResult =
  | { message: string; level?: MessageLevel }
  | { image: { mimeType: string; base64: string }; caption?: string }
  | { link: string; label?: string };

export interface ConfigurationChange<Values> {
  previous: Values | null;
  current: Values | null;
}

export type RouteCheck<Types extends ServiceTypes = AnyServiceTypes> = (
  request: Request,
  ctx: RouteContext<Types>
) => Awaitable<Verdict>;

export type RouteHandler<Types extends ServiceTypes = AnyServiceTypes> = (
  request: Request,
  ctx: RouteContext<Types>
) => Awaitable<Response | Verdict>;

export type Forward = (request?: Request) => Promise<Response>;

export type RouteThrough<Types extends ServiceTypes = AnyServiceTypes> = (
  request: Request,
  ctx: RouteContext<Types>,
  forward: Forward
) => Awaitable<Response | Verdict>;

export interface OutgoingRequest {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
}

export interface UpstreamCredentials {
  headers?: Record<string, string | Secret>;
  query?: Record<string, string | Secret>;
}

export interface UpstreamOptions<Types extends ServiceTypes = AnyServiceTypes> {
  name: string;
  api: string;
  url: string | ((configurations: Configurations<Types>) => string);
  mount?: string;
  credentials?: (configurations: Configurations<Types>, outgoing: OutgoingRequest) => Awaitable<UpstreamCredentials>;
}

export interface Upstream<Types extends ServiceTypes = AnyServiceTypes> extends UpstreamOptions<Types> {
  fetch(on: LookupSource, path: string, init?: RequestInit): Promise<Response>;
}

export interface RouteOptions<Types extends ServiceTypes = AnyServiceTypes> {
  summary: string;
  allowedBy: readonly Types['settings'][];
  check?: RouteCheck<Types>;
  to?: Upstream<Types>;
  handle?: RouteHandler<Types>;
  through?: RouteThrough<Types>;
  bodyLimit?: number;
}

export type RouteAction = 'proxy' | 'handle' | 'refuse';

export interface Route<Types extends ServiceTypes = AnyServiceTypes> extends RouteOptions<Types> {
  readonly pattern: RoutePattern;
  readonly action: RouteAction;
}

export interface CounterDeclaration {
  label: string;
  description?: string;
}

export interface FormHandlerContext<Types extends ServiceTypes = AnyServiceTypes> extends LookupSource {
  readonly caller: CallerIdentity;
  readonly form: FormName;
  readonly serviceConfiguration: Types['serviceConfiguration'];
  readonly projectConfiguration: Types['projectConfiguration'] | null;
  readonly state: AtomicServiceState;
  readonly service: ServiceHandle<Types>;
  note(fields: Record<string, unknown>): void;
}

export interface WebhookContext<Types extends ServiceTypes = AnyServiceTypes> extends LookupSource {
  readonly caller: CallerIdentity;
  readonly serviceConfiguration: Types['serviceConfiguration'];
  readonly state: AtomicServiceState;
  readonly service: ServiceHandle<Types>;
  note(fields: Record<string, unknown>): void;
}

export type WebhookHandler<Types extends ServiceTypes = AnyServiceTypes> = (
  request: Request,
  ctx: WebhookContext<Types>
) => Awaitable<Response | undefined | void>;

export interface FormDraft {
  form: FormName;
  values: FormValues;
  item?: string;
}

export interface OptionsDraft extends FormDraft {
  query: string;
}

export interface ConfigurationHooks<Types extends ServiceTypes = AnyServiceTypes> {
  onServiceConfigurationSaved?(
    change: ConfigurationChange<Types['serviceConfiguration']>,
    ctx: FormHandlerContext<Types>
  ): Awaitable<void>;
  onProjectConfigurationSaved?(
    change: ConfigurationChange<Types['projectConfiguration']>,
    ctx: FormHandlerContext<Types>
  ): Awaitable<void>;
}

export interface ServiceDefinition<Types extends ServiceTypes = AnyServiceTypes> {
  manifest: unknown;
  routes: readonly Route<Types>[];
  counters?: Record<string, CounterDeclaration>;
  options?: Record<string, (draft: OptionsDraft, ctx: FormHandlerContext<Types>) => Awaitable<OptionItem[]>>;
  info?: Record<string, (draft: FormDraft, ctx: FormHandlerContext<Types>) => Awaitable<InfoResult>>;
  buttons?: Record<string, (draft: FormDraft, ctx: FormHandlerContext<Types>) => Awaitable<ButtonResult>>;
  hooks?: ConfigurationHooks<Types>;
  webhook?: WebhookHandler<Types>;
  background?: (service: ServiceHandle<Types>, signal: AbortSignal) => unknown;
  refusal?: RefusalOverride;
}

export interface DefinedService<Types extends ServiceTypes = AnyServiceTypes> {
  readonly definition: ServiceDefinition<Types>;
  readonly manifest: ServiceManifest;
  readonly manifestHash: string;
}

export class ServiceDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceDefinitionError';
  }
}

export const defaultBodyLimit = 10 * 1024 * 1024;

export const builtInCounterNames = ['requests', 'not_allowed', 'failed', 'events'] as const;

export type BuiltInCounterName = (typeof builtInCounterNames)[number];

export const builtInCounters: Record<BuiltInCounterName, CounterDeclaration> = {
  requests: { label: 'Requests', description: 'Requests from Projects, whatever their outcome' },
  not_allowed: {
    label: 'Not allowed',
    description: 'Requests refused because a setting does not allow them or the Project is not set up',
  },
  failed: { label: 'Failed', description: 'Requests the service could not answer' },
  events: { label: 'Events', description: 'Events stored for the Project' },
};

export const counterLimits = { maxCounters: 20, maxLabelLength: 60, maxCount: 1_000_000_000 } as const;

const counterNamePattern = /^[a-z][a-z0-9_]{0,62}$/;

const definedServices = new WeakSet<object>();

export function isDefinedService(value: unknown): value is DefinedService {
  return typeof value === 'object' && value !== null && definedServices.has(value);
}

export async function allowAll(_request: Request, ctx: { allow(): Verdict }): Promise<Verdict> {
  return ctx.allow();
}

export function route<Types extends ServiceTypes = AnyServiceTypes>(
  pattern: string,
  options: RouteOptions<Types>
): Route<Types> {
  const parsed = parseRoutePattern(pattern);
  if (options.to !== undefined && options.handle !== undefined) {
    throw new ServiceDefinitionError(`route '${pattern}': give either to or handle, not both`);
  }
  if (options.through !== undefined && options.to === undefined) {
    throw new ServiceDefinitionError(`route '${pattern}': through works only on a route with to`);
  }
  const action: RouteAction = options.to ? 'proxy' : options.handle ? 'handle' : 'refuse';
  if (action !== 'refuse' && typeof options.check !== 'function') {
    throw new ServiceDefinitionError(
      `route '${pattern}': every route that passes or handles a request needs a check (or check: allowAll)`
    );
  }
  if (typeof options.summary !== 'string' || options.summary.trim() === '') {
    throw new ServiceDefinitionError(`route '${pattern}': summary says in one line what the route does`);
  }
  if (!Array.isArray(options.allowedBy) || options.allowedBy.some((setting) => typeof setting !== 'string')) {
    throw new ServiceDefinitionError(
      `route '${pattern}': allowedBy lists the Project-form settings that govern the route ([] when none does)`
    );
  }
  if (
    options.bodyLimit !== undefined &&
    (!Number.isInteger(options.bodyLimit) || options.bodyLimit < 0 || options.bodyLimit > defaultBodyLimit * 10)
  ) {
    throw new ServiceDefinitionError(`route '${pattern}': bodyLimit is a whole number of bytes`);
  }
  return Object.freeze({ ...options, pattern: parsed, action });
}

export function upstream<Types extends ServiceTypes = AnyServiceTypes>(
  options: UpstreamOptions<Types>
): Upstream<Types> {
  if (!/^[a-z][a-z0-9_-]{0,62}$/.test(options.name)) {
    throw new ServiceDefinitionError(`upstream '${options.name}': names are lower case letters, digits, - or _`);
  }
  if (options.mount !== undefined && !/^(\/[^/]+)+$/.test(options.mount)) {
    throw new ServiceDefinitionError(`upstream '${options.name}': mount is a path prefix like /api/v3`);
  }
  const declared: Upstream<Types> = {
    ...options,
    fetch(on, path, init) {
      const lookup = on[upstreamLookups];
      if (!lookup) {
        return Promise.reject(new TypeError(`${options.name}.fetch needs the ctx or service it runs for`));
      }
      return lookup(declared as Upstream<never>, path, init);
    },
  };
  return Object.freeze(declared);
}

function checkCounters(counters: Record<string, CounterDeclaration>): void {
  const names = Object.keys(counters);
  if (names.length > counterLimits.maxCounters) {
    throw new ServiceDefinitionError(`a service declares at most ${counterLimits.maxCounters} counters`);
  }
  for (const [name, declaration] of Object.entries(counters)) {
    if (!counterNamePattern.test(name)) {
      throw new ServiceDefinitionError(`counter '${name}': names are snake_case, like pull_requests_opened`);
    }
    if ((builtInCounterNames as readonly string[]).includes(name)) {
      throw new ServiceDefinitionError(`counter '${name}': the name is kept for a built-in counter`);
    }
    const label = declaration?.label;
    if (typeof label !== 'string' || label.trim() === '' || label.length > counterLimits.maxLabelLength) {
      throw new ServiceDefinitionError(`counter '${name}': label is 1 to ${counterLimits.maxLabelLength} characters`);
    }
  }
}

export function defineService<Types extends ServiceTypes = AnyServiceTypes>(
  definition: ServiceDefinition<Types>
): DefinedService<Types> {
  const check = checkServiceManifest(definition.manifest);
  if (!check.ok || !check.manifest) {
    const errors = check.problems
      .filter((problem) => problem.severity === 'error')
      .map((problem) => `${problem.path === '' ? 'service.json' : problem.path}: ${problem.message}`);
    throw new ServiceDefinitionError(`service.json is invalid:\n${errors.join('\n')}`);
  }
  if (!Array.isArray(definition.routes)) {
    throw new ServiceDefinitionError('routes is the ordered list of the routes this service serves');
  }
  for (const [index, entry] of definition.routes.entries()) {
    if (typeof entry?.pattern?.source !== 'string') {
      throw new ServiceDefinitionError(`routes[${index}] is not made with route(…)`);
    }
  }
  checkCounters(definition.counters ?? {});
  const defined: DefinedService<Types> = Object.freeze({
    definition,
    manifest: check.manifest,
    manifestHash: computeManifestHash(definition.manifest),
  });
  definedServices.add(defined);
  return defined;
}
