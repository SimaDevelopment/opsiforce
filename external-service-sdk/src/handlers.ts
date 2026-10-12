import type { Bounds } from './bounds.ts';
import type { Secret } from './secret.ts';

export interface ManifestTypes {
  manifestHash: string;
  operations: object;
  events: object;
  options: string;
  info: string;
  buttons: string;
  bounds: string;
  inbound: boolean;
  serviceConfiguration: object;
  projectConfiguration: object;
}

export type Awaitable<T> = T | Promise<T>;

export type CallerVia = 'agent' | 'app' | 'form' | (string & {});

export interface Caller {
  tenantId: string;
  projectId: string;
  environmentId: string;
  environment: string;
  via: CallerVia;
}

export type LogFields = Record<string, unknown>;

export interface ServiceLog {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export interface StateEntry {
  key: string;
  value: unknown;
}

export interface ServiceState {
  get<Value = unknown>(key: string): Promise<Value | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<StateEntry[]>;
}

export const fileResultMarker: unique symbol = Symbol.for('opsiforce.external-service.file-result');

export interface FileResult {
  readonly [fileResultMarker]: true;
  bytes: Uint8Array;
  mimeType: string;
  filename?: string;
}

export interface FileOptions {
  mimeType: string;
  filename?: string;
}

export interface BaseContext<M extends ManifestTypes> {
  serviceConfiguration: M['serviceConfiguration'];
  callId: string;
  signal: AbortSignal;
  webhookUrl: string;
  log: ServiceLog;
  state: ServiceState;
}

export interface PlatformApiAccess {
  url: string;
  token: Secret;
}

export interface OperationContext<M extends ManifestTypes> extends BaseContext<M> {
  operation: string;
  projectConfiguration: M['projectConfiguration'];
  bounds: Bounds<M['bounds']>;
  caller: Caller;
  platformApi?: PlatformApiAccess;
  file(bytes: Uint8Array | string, options: FileOptions): FileResult;
}

export type FormName = 'serviceForm' | 'projectForm';

export interface FormCallContext<M extends ManifestTypes> extends BaseContext<M> {
  form: FormName;
  caller: Caller | undefined;
}

export interface HookContext<M extends ManifestTypes> extends BaseContext<M> {
  caller: Caller | undefined;
}

export type InboundContext<M extends ManifestTypes> = BaseContext<M>;

export interface OptionsRequest {
  query: string;
  values: Record<string, unknown>;
}

export interface OptionItem {
  value: string;
  label: string;
  description?: string;
}

export interface FormCallRequest {
  values: Record<string, unknown>;
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

export interface InboundFile {
  field?: string;
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface InboundRequest {
  method: string;
  headers: Record<string, string>;
  query: Record<string, string | string[]>;
  rawBody: Uint8Array;
  body: unknown;
  files: InboundFile[];
}

export interface EventFile {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}

export type InboundEvent<M extends ManifestTypes> = {
  [Type in keyof M['events'] & string]: {
    type: Type;
    key: string;
    occurredAt: string;
    data: M['events'][Type];
    files?: EventFile[];
  };
}[keyof M['events'] & string];

export interface InboundResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface InboundResult<M extends ManifestTypes> {
  events: InboundEvent<M>[];
  response?: InboundResponse;
}

export interface ConfigurationChange<Values> {
  previous: Values | null;
  current: Values | null;
}

export interface Hooks<M extends ManifestTypes> {
  onServiceConfigurationSaved?(
    change: ConfigurationChange<M['serviceConfiguration']>,
    ctx: HookContext<M>
  ): Awaitable<void>;
  onProjectConfigurationSaved?(
    change: ConfigurationChange<M['projectConfiguration'] & { receive?: Record<string, boolean> }>,
    ctx: HookContext<M>
  ): Awaitable<void>;
}

export const hookNames = ['onServiceConfigurationSaved', 'onProjectConfigurationSaved'] as const;

export type HookName = (typeof hookNames)[number];

export type OperationHandler<M extends ManifestTypes, Input> = (
  input: Input,
  ctx: OperationContext<M>
) => Awaitable<unknown>;
export type OptionsHandler<M extends ManifestTypes> = (
  request: OptionsRequest,
  ctx: FormCallContext<M>
) => Awaitable<OptionItem[]>;
export type InfoHandler<M extends ManifestTypes> = (
  request: FormCallRequest,
  ctx: FormCallContext<M>
) => Awaitable<InfoResult>;
export type ButtonHandler<M extends ManifestTypes> = (
  request: FormCallRequest,
  ctx: FormCallContext<M>
) => Awaitable<ButtonResult>;
export type InboundHandler<M extends ManifestTypes> = (
  request: InboundRequest,
  ctx: InboundContext<M>
) => Awaitable<InboundResult<M>>;

type HandlerGroup<Group extends string, Names extends string, Handler> = [Names] extends [never]
  ? { [Key in Group]?: Record<never, Handler> }
  : { [Key in Group]: { [Name in Names]: Handler } };

type OperationGroup<M extends ManifestTypes> = [keyof M['operations'] & string] extends [never]
  ? { operations?: Record<never, AnyHandler> }
  : { operations: { [Name in keyof M['operations'] & string]: OperationHandler<M, M['operations'][Name]> } };

export type ServiceHandlers<M extends ManifestTypes> = {
  manifestHash: M['manifestHash'];
  hooks?: Hooks<M>;
} & OperationGroup<M> &
  HandlerGroup<'options', M['options'], OptionsHandler<M>> &
  HandlerGroup<'info', M['info'], InfoHandler<M>> &
  HandlerGroup<'buttons', M['buttons'], ButtonHandler<M>> &
  (M['inbound'] extends true ? { inbound: InboundHandler<M> } : { inbound?: undefined });

export type AnyHandler = (request: never, ctx: never) => unknown;

export interface AnyServiceHandlers {
  manifestHash: string;
  operations?: Record<string, AnyHandler>;
  options?: Record<string, AnyHandler>;
  info?: Record<string, AnyHandler>;
  buttons?: Record<string, AnyHandler>;
  hooks?: Partial<Record<HookName, AnyHandler>>;
  inbound?: AnyHandler;
}

export function defineHandlers<M extends ManifestTypes>(handlers: ServiceHandlers<M>): ServiceHandlers<M> {
  return handlers;
}
