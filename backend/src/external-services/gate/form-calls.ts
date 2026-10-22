import { randomUUID } from 'node:crypto';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Field } from '@opsiforce/external-service-sdk';
import { failureMessages } from '@opsiforce/external-service-sdk/platform';
import { formCallResultSchemas } from '@opsiforce/external-service-sdk/server';
import {
  callersOwner,
  isListItem,
  isPlainValues,
  masked,
  servicePlaceOf,
  type ConfigurationValues,
  type SealingPlaceOf,
} from '../configuration/configuration-values';
import { ConfigurationDelivery } from '../configuration/configuration-delivery';
import { projectPlaceOf } from '../configuration/project-configuration.store';
import type { ProjectFormCallTarget } from '../configuration/project-service-views';
import { ServiceConfigurationStore } from '../configuration/service-configuration.store';
import { problem } from '../http/problem-reply';
import { servableOrNone, type ServiceLane } from '../registry/custom-service-catalog';
import { ServiceRegistry, type RegisteredService } from '../registry/service-registry';
import { checkServiceAnswer } from './answer-checks';
import { refuse } from './gate-refusals';
import {
  answeredOrProblem,
  answeredProblem,
  dispatchedOrRefused,
  openedOrRefused,
  problemAnswer,
  type GateAnswer,
} from './service-answers';
import { cappedFormAnswer } from './form-answer-caps';
import {
  platformCallTargetOf,
  ServiceDispatcher,
  type PlatformCallTarget,
  type ServiceResponse,
} from './service-dispatcher';

export const formCallRoutes = ['options', 'info', 'buttons'] as const;

export type FormCallRoute = (typeof formCallRoutes)[number];

export function formCallRouteOf(route: string): FormCallRoute | null {
  return (formCallRoutes as readonly string[]).includes(route) ? (route as FormCallRoute) : null;
}

type FormName = 'serviceForm' | 'projectForm';

export interface FormCallRequest {
  route: FormCallRoute;
  name: string;
  body: unknown;
}

export interface ServiceFormCallRequest extends FormCallRequest {
  serviceId: string;
  tenantId?: string;
  lane?: ServiceLane;
}

export interface ProjectFormCallRequest extends FormCallRequest {
  target: ProjectFormCallTarget;
}

export interface DevelopmentServiceFormCallRequest extends FormCallRequest {
  development: RegisteredService;
}

interface FormCallBody {
  values: ConfigurationValues;
  query: string;
  item: string | null;
}

interface DraftCall {
  service: RegisteredService;
  form: FormName;
  stored: ConfigurationValues;
  placeOf: SealingPlaceOf;
  body: FormCallBody;
  for?: PlatformCallTarget;
}

const maxQueryLength = 500;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function parsedJson(body: Uint8Array): unknown {
  try {
    return JSON.parse(decoder.decode(body));
  } catch {
    return undefined;
  }
}

function formCallAnswer(
  callId: string,
  service: RegisteredService,
  route: FormCallRoute,
  response: ServiceResponse
): GateAnswer {
  if (response.status !== 200) {
    const answered = answeredProblem(service, response);
    return problemAnswer(callId, problem({ status: response.status, code: answered.code, detail: answered.detail }));
  }
  const checked = formCallResultSchemas[route].safeParse(parsedJson(response.body));
  const capped = checked.success ? cappedFormAnswer(route, checked.data) : null;
  if (capped === null) {
    refuse({
      status: 502,
      code: 'service-failed',
      detail:
        route === 'options'
          ? `${service.manifest.displayName} sent choices this form can't show.`
          : `${service.manifest.displayName} sent an answer this form can't show.`,
    });
  }
  return {
    callId,
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: encoder.encode(JSON.stringify(capped)),
  };
}

function refuseOutOfDate(status: number, code: string): never {
  refuse({ status, code, detail: failureMessages.formOutOfDate() });
}

function calls(field: Field, route: FormCallRoute, name: string): boolean {
  if (route === 'options') {
    return 'options' in field && isPlainValues(field.options) && 'call' in field.options && field.options.call === name;
  }
  if (route === 'info') return field.type === 'info' && field.call === name;
  return field.type === 'button' && field.call === name;
}

function callingLists(
  fields: readonly Field[],
  route: FormCallRoute,
  name: string,
  list: string | null
): (string | null)[] {
  return fields.flatMap((field) => {
    if (field.type === 'section') return callingLists(field.fields, route, name, list);
    if (field.type === 'list') return callingLists(field.item as readonly Field[], route, name, field.key);
    return calls(field, route, name) ? [list] : [];
  });
}

function parsedBody(body: unknown): FormCallBody {
  const fields = isPlainValues(body) ? body : {};
  const { values = {}, query = '', item = null } = fields;
  if (!isPlainValues(values)) refuseOutOfDate(400, 'invalid-form-call');
  if (typeof query !== 'string' || query.length > maxQueryLength) refuseOutOfDate(400, 'invalid-form-call');
  if (item !== null && typeof item !== 'string') refuseOutOfDate(400, 'invalid-form-call');
  return { values, query, item };
}

function checkCalledField(
  service: RegisteredService,
  form: FormName,
  request: FormCallRequest,
  body: FormCallBody
): void {
  const lists = callingLists(service.manifest[form] ?? [], request.route, request.name, null);
  if (lists.length === 0) {
    refuseOutOfDate(404, 'unknown-callback');
  }
  if (body.item === null) {
    if (lists.includes(null)) return;
    refuseOutOfDate(400, 'invalid-form-call');
  }
  const itemId = body.item;
  const list = lists.find((candidate): candidate is string => {
    if (candidate === null) return false;
    const items = body.values[candidate];
    return Array.isArray(items) && items.some((entry) => isListItem(entry) && entry.id === itemId);
  });
  if (list === undefined) {
    refuseOutOfDate(400, 'unknown-item');
  }
}

@Injectable()
export class FormCalls {
  private readonly logger = new Logger(FormCalls.name);

  constructor(
    private readonly registry: ServiceRegistry,
    private readonly serviceConfigurations: ServiceConfigurationStore,
    private readonly delivery: ConfigurationDelivery,
    private readonly dispatcher: ServiceDispatcher
  ) {}

  async callServiceForm(request: ServiceFormCallRequest): Promise<GateAnswer> {
    const service = await this.serviceFormOwnedBy(request.tenantId ?? null, request.serviceId, request.lane);
    return this.serviceFormCall(service, request, (body) => body);
  }

  async callDevelopmentServiceForm(request: DevelopmentServiceFormCallRequest): Promise<GateAnswer> {
    const { development } = request;
    const saved = await this.serviceConfigurations.read(development, callersOwner(development));
    return this.serviceFormCall(development, request, (body) => ({
      ...body,
      values: { ...masked(development.manifest.serviceForm ?? [], saved.values), ...body.values },
    }));
  }

  private serviceFormCall(
    service: RegisteredService,
    request: FormCallRequest,
    draftOf: (body: FormCallBody) => FormCallBody
  ): Promise<GateAnswer> {
    const callId = randomUUID();
    return answeredOrProblem(this.logger, callId, async () => {
      const body = draftOf(parsedBody(request.body));
      checkCalledField(service, 'serviceForm', request, body);
      const serviceConfiguration = await this.serviceConfigurations.read(service, callersOwner(service));
      return this.dispatched(callId, request, {
        service,
        form: 'serviceForm',
        stored: serviceConfiguration.values,
        placeOf: servicePlaceOf(service, callersOwner(service)),
        body,
      });
    });
  }

  callProjectForm(request: ProjectFormCallRequest): Promise<GateAnswer> {
    const { target } = request;
    const callId = randomUUID();
    return answeredOrProblem(this.logger, callId, async () => {
      const body = parsedBody(request.body);
      checkCalledField(target.service, 'projectForm', request, body);
      return this.dispatched(callId, request, {
        service: target.service,
        form: 'projectForm',
        stored: target.projectConfiguration.values,
        placeOf: projectPlaceOf(target.service, target.projectEnvironmentId),
        body,
        for: platformCallTargetOf(target),
      });
    });
  }

  private async serviceFormOwnedBy(
    tenantId: string | null,
    serviceId: string,
    lane: ServiceLane = 'default'
  ): Promise<RegisteredService> {
    const service =
      lane === 'development'
        ? ((await servableOrNone(this.registry.development(serviceId))) ?? undefined)
        : tenantId
          ? await this.registry.byIdForTenant(tenantId, serviceId)
          : this.registry.byId(serviceId);
    if (!service || service.tenantId !== tenantId) throw new NotFoundException(`No External Service ${serviceId}`);
    return service;
  }

  private async dispatched(callId: string, request: FormCallRequest, call: DraftCall): Promise<GateAnswer> {
    const { service, form, body } = call;
    const values = openedOrRefused(this.logger, callId, service, () =>
      this.delivery.forDraft({
        form: service.manifest[form] ?? [],
        stored: call.stored,
        unsaved: body.values,
        placeOf: call.placeOf,
      })
    );
    const response = await dispatchedOrRefused(service, () =>
      this.dispatcher.dispatch(service, {
        route: request.route,
        name: request.name,
        body: {
          form,
          values,
          ...(request.route === 'options' ? { query: body.query } : {}),
          ...(body.item === null ? {} : { item: body.item }),
        },
        ...(call.for ? { for: call.for } : {}),
      })
    );
    checkServiceAnswer({ callId, service, response }, this.logger);
    return formCallAnswer(callId, service, request.route, response);
  }
}
