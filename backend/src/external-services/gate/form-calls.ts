import { randomUUID } from 'node:crypto';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { problem, type Field } from '@opsiforce/external-service-sdk';
import { inputBytesOf } from '@opsiforce/external-service-sdk/platform';
import { formCallResultSchemas, type ServiceResponse, type WireContext } from '@opsiforce/external-service-sdk/server';
import {
  callersOwner,
  isListItem,
  isPlainValues,
  type ConfigurationValues,
} from '../configuration/configuration-values';
import {
  ConfigurationDelivery,
  type DeliveredFormCall,
  type EditedItem,
} from '../configuration/configuration-delivery';
import type { ProjectFormCallTarget } from '../configuration/project-service-views';
import { ServiceConfigurationStore } from '../configuration/service-configuration.store';
import { userIdOf } from '../configuration/user-ids';
import { DispatchContexts } from './dispatch-contexts';
import { servableOrNone, type ServiceLane } from '../registry/custom-service-catalog';
import { ServiceRegistry, type RegisteredService } from '../registry/service-registry';
import { checkServiceAnswer } from './answer-checks';
import { CallLog, type CallRecord } from './call-log';
import { refuse } from './gate-refusals';
import {
  answeredOrProblemAndLogged,
  answeredProblem,
  dispatchedOrRefused,
  openedOrRefused,
  problemAnswer,
  type GateAnswer,
} from './service-answers';
import { ServiceDispatcher } from './service-dispatcher';

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
  keycloakId: string;
  tenantId?: string;
  lane?: ServiceLane;
}

export interface ProjectFormCallRequest extends FormCallRequest {
  target: ProjectFormCallTarget;
}

interface FormCallBody {
  values: ConfigurationValues;
  query: string;
  item: string | null;
}

interface PreparedFormCall {
  body: FormCallBody;
  editedItem: EditedItem | null;
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

function formCallAnswer(callId: string, route: FormCallRoute, response: ServiceResponse): GateAnswer {
  if (response.status !== 200) {
    const answered = answeredProblem(response);
    return problemAnswer(
      callId,
      problem({
        status: response.status,
        code: answered.code ?? 'service-failed',
        ...(answered.detail === null ? {} : { detail: answered.detail }),
      })
    );
  }
  const checked = formCallResultSchemas[route].safeParse(parsedJson(response.body));
  if (!checked.success) {
    refuse({
      status: 502,
      code: 'service-failed',
      detail: `The service answered ${route} with something the form cannot show.`,
    });
  }
  return {
    callId,
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: encoder.encode(JSON.stringify(checked.data)),
  };
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
  if (!isPlainValues(values)) refuse({ status: 400, code: 'invalid-form-call', detail: 'values must be an object.' });
  if (typeof query !== 'string' || query.length > maxQueryLength) {
    refuse({
      status: 400,
      code: 'invalid-form-call',
      detail: `query must be text of at most ${maxQueryLength} characters.`,
    });
  }
  if (item !== null && typeof item !== 'string') {
    refuse({ status: 400, code: 'invalid-form-call', detail: 'item must be the id of a list item.' });
  }
  return { values, query, item };
}

function editedItemOf(
  service: RegisteredService,
  form: FormName,
  request: FormCallRequest,
  body: FormCallBody
): EditedItem | null {
  const lists = callingLists(service.manifest[form] ?? [], request.route, request.name, null);
  if (lists.length === 0) {
    refuse({
      status: 404,
      code: 'unknown-callback',
      detail: `No field of "${service.slug}"'s ${form === 'serviceForm' ? 'Service' : 'Project'} form calls ${request.route}.${request.name}.`,
    });
  }
  if (body.item === null) {
    if (lists.includes(null)) return null;
    refuse({
      status: 400,
      code: 'invalid-form-call',
      detail: `${request.route}.${request.name} belongs to a list item: send the item's id.`,
    });
  }
  const itemId = body.item;
  const list = lists.find((candidate): candidate is string => {
    if (candidate === null) return false;
    const items = body.values[candidate];
    return Array.isArray(items) && items.some((entry) => isListItem(entry) && entry.id === itemId);
  });
  if (list === undefined) {
    refuse({ status: 400, code: 'unknown-item', detail: `The form values hold no list item ${itemId}.` });
  }
  return { list, id: itemId };
}

@Injectable()
export class FormCalls {
  private readonly logger = new Logger(FormCalls.name);

  constructor(
    private readonly registry: ServiceRegistry,
    private readonly serviceConfigurations: ServiceConfigurationStore,
    private readonly delivery: ConfigurationDelivery,
    private readonly dispatcher: ServiceDispatcher,
    private readonly contexts: DispatchContexts,
    private readonly callLog: CallLog
  ) {}

  async callServiceForm(request: ServiceFormCallRequest): Promise<GateAnswer> {
    const service = await this.serviceFormOwnedBy(request.tenantId ?? null, request.serviceId, request.lane);
    const call = this.callRecord(service, request, {
      userId: await userIdOf(request.keycloakId),
      tenantId: service.tenantId,
    });
    return answeredOrProblemAndLogged(this.logger, this.callLog, call, async () => {
      const prepared = this.prepared(service, 'serviceForm', request);
      const serviceConfiguration = await this.serviceConfigurations.read(service, callersOwner(service));
      const delivered = openedOrRefused(this.logger, call.id, service, () =>
        this.delivery.forServiceFormCall({
          service,
          owner: callersOwner(service),
          serviceConfiguration: serviceConfiguration.values,
          unsaved: prepared.body.values,
          editedItem: prepared.editedItem,
        })
      );
      return this.dispatched(service, 'serviceForm', request, call, prepared, delivered);
    });
  }

  callProjectForm(request: ProjectFormCallRequest): Promise<GateAnswer> {
    const { target } = request;
    const call = this.callRecord(target.service, request, {
      userId: target.userId,
      tenantId: target.tenantId,
      projectId: target.projectId,
      projectTitle: target.projectTitle,
      projectEnvironmentId: target.projectEnvironmentId,
    });
    return answeredOrProblemAndLogged(this.logger, this.callLog, call, async () => {
      const prepared = this.prepared(target.service, 'projectForm', request);
      const delivered = openedOrRefused(this.logger, call.id, target.service, () =>
        this.delivery.forProjectFormCall({
          service: target.service,
          owner: callersOwner(target.service),
          serviceConfiguration: target.serviceConfiguration.values,
          projectEnvironmentId: target.projectEnvironmentId,
          projectConfiguration: target.projectConfiguration.values,
          unsaved: prepared.body.values,
          editedItem: prepared.editedItem,
        })
      );
      return this.dispatched(target.service, 'projectForm', request, call, prepared, delivered, {
        tenantId: target.tenantId,
        projectId: target.projectId,
        environmentId: target.projectEnvironmentId,
        environment: target.environment,
        via: 'form',
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

  private callRecord(service: RegisteredService, request: FormCallRequest, fields: Partial<CallRecord>): CallRecord {
    return {
      id: randomUUID(),
      kind: 'form',
      via: 'form',
      externalServiceId: service.id,
      slug: service.slug,
      manifestHash: service.manifestHash,
      operation: request.name,
      operationKind: request.route,
      inputBytes: inputBytesOf(request.body ?? {}),
      decision: 'refused',
      status: 0,
      durationMs: 0,
      ...fields,
    };
  }

  private prepared(service: RegisteredService, form: FormName, request: FormCallRequest): PreparedFormCall {
    const body = parsedBody(request.body);
    return { body, editedItem: editedItemOf(service, form, request, body) };
  }

  private async dispatched(
    service: RegisteredService,
    form: FormName,
    request: FormCallRequest,
    call: CallRecord,
    prepared: PreparedFormCall,
    delivered: DeliveredFormCall,
    caller?: WireContext['caller']
  ): Promise<GateAnswer> {
    call.decision = 'allowed';
    const response = await dispatchedOrRefused(service, () =>
      this.dispatcher.dispatch(service, {
        route: request.route,
        name: request.name,
        body: {
          context: this.contexts.of(service, {
            callId: call.id,
            caller,
            serviceConfiguration: delivered.serviceConfiguration,
          }),
          form,
          values: delivered.values,
          ...(request.route === 'options' ? { query: prepared.body.query } : {}),
        },
      })
    );
    call.outputBytes = response.body.byteLength;
    checkServiceAnswer({ callId: call.id, service, response, sentSecrets: delivered.sentSecrets }, this.logger);
    Object.assign(call, answeredProblem(response));
    return formCallAnswer(call.id, request.route, response);
  }
}
