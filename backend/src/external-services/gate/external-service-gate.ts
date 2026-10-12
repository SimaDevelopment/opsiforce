import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { createOperationAdmission, type OperationAdmissionGate } from '@opsiforce/external-service-sdk/platform';
import type { WireContext } from '@opsiforce/external-service-sdk/server';
import type { JsonValue } from '../../common/json';
import { ConfigurationDelivery } from '../configuration/configuration-delivery';
import { callersOwner } from '../configuration/configuration-values';
import { ProjectConfigurationStore, storedShapeOf } from '../configuration/project-configuration.store';
import { ServiceConfigurationStore } from '../configuration/service-configuration.store';
import { ServiceRegistry, type RegisteredService } from '../registry/service-registry';
import { checkServiceAnswer } from './answer-checks';
import { DispatchContexts } from './dispatch-contexts';
import { CallLog, type CallRecord } from './call-log';
import { GateCallers, type GateCaller, type GateCallerSource } from './gate-caller';
import { PlatformApiGrant } from './platform-api-grant';
import { resolveCallable } from './callable-service';
import { GateRefusal, refuse, refuseUnconfiguredService, refuseUnknownCaller } from './gate-refusals';
import type { GateVia } from './gate-routes';
import {
  answeredOrProblemAndLogged,
  answeredProblem,
  dispatchedOrRefused,
  forwardedAnswer,
  openedOrRefused,
  type GateAnswer,
} from './service-answers';
import { ServiceDispatcher } from './service-dispatcher';

export type { GateAnswer } from './service-answers';

export interface OperationCallRequest {
  from: GateCallerSource;
  slug: string;
  operation: string;
  input: unknown;
  inputBytes: number;
  via: GateVia;
}

@Injectable()
export class ExternalServiceGate {
  private readonly logger = new Logger(ExternalServiceGate.name);
  private readonly admissions = new Map<string, OperationAdmissionGate>();

  constructor(
    private readonly callers: GateCallers,
    private readonly registry: ServiceRegistry,
    private readonly serviceConfigurations: ServiceConfigurationStore,
    private readonly projectConfigurationStore: ProjectConfigurationStore,
    private readonly delivery: ConfigurationDelivery,
    private readonly dispatcher: ServiceDispatcher,
    private readonly contexts: DispatchContexts,
    private readonly callLog: CallLog,
    private readonly platformApi: PlatformApiGrant
  ) {}

  callOperation(request: OperationCallRequest): Promise<GateAnswer> {
    const call: CallRecord = {
      id: randomUUID(),
      kind: 'operation',
      via: request.via,
      slug: request.slug,
      operation: request.operation,
      inputBytes: request.inputBytes,
      decision: 'refused',
      status: 0,
      durationMs: 0,
    };
    return answeredOrProblemAndLogged(this.logger, this.callLog, call, () => this.admitAndDispatch(request, call));
  }

  private async admitAndDispatch(request: OperationCallRequest, call: CallRecord): Promise<GateAnswer> {
    const caller = await this.callers.resolve(request.from);
    if (!caller) refuseUnknownCaller();
    Object.assign(call, {
      tenantId: caller.tenantId,
      projectId: caller.projectId,
      projectTitle: caller.projectTitle,
      projectEnvironmentId: caller.projectEnvironmentId,
    });

    const service = await resolveCallable(this.registry, caller, request.slug);
    call.externalServiceId = service.id;
    call.serviceEnvironmentId = service.home?.environmentId ?? null;

    const serviceConfiguration = await this.serviceConfigurations.read(service, callersOwner(service));
    if (serviceConfiguration.missing.length > 0) refuseUnconfiguredService(request.slug);

    call.manifestHash = service.manifestHash;

    const operations = service.manifest.operations ?? {};
    const operation = Object.hasOwn(operations, request.operation) ? operations[request.operation] : undefined;
    if (operation) call.operationKind = operation.kind;
    const projectConfiguration = await this.projectConfigurationStore.read(service, caller.projectEnvironmentId);
    if (operation && projectConfiguration.missing.length > 0) {
      refuse({
        status: 409,
        code: 'configuration-incomplete',
        detail: `This Project's configuration of "${request.slug}" is missing ${projectConfiguration.missing.join(', ')}.`,
        service: request.slug,
        missing: projectConfiguration.missing,
      });
    }

    const stored = storedShapeOf(projectConfiguration);
    const admission = this.admissionFor(service).admit({
      operation: request.operation,
      input: request.input,
      inputBytes: request.inputBytes,
      projectConfiguration: stored,
      serviceConfiguration: serviceConfiguration.values,
    });
    if (admission.touched) call.bounds = admission.touched as unknown as JsonValue;
    if (!admission.admitted) throw new GateRefusal(admission.problem);

    const delivered = openedOrRefused(this.logger, call.id, service, () =>
      this.delivery.forProject({
        service,
        owner: callersOwner(service),
        serviceConfiguration: serviceConfiguration.values,
        projectEnvironmentId: caller.projectEnvironmentId,
        projectConfiguration: stored,
      })
    );

    call.decision = 'allowed';
    const platformApi = this.platformApi.grantFor(service, { callId: call.id, operation: request.operation, caller });
    const response = await dispatchedOrRefused(service, () =>
      this.dispatcher.dispatch(service, {
        route: 'operations',
        name: request.operation,
        body: {
          context: {
            ...this.contexts.of(service, {
              callId: call.id,
              caller: this.wireCaller(caller, request.via),
              serviceConfiguration: delivered.serviceConfiguration,
            }),
            projectConfiguration: delivered.projectConfiguration,
            ...platformApi?.contextFields,
          },
          input: admission.input,
        },
      })
    ).finally(() => platformApi?.revoke());
    call.outputBytes = response.body.byteLength;
    checkServiceAnswer({ callId: call.id, service, response, sentSecrets: delivered.sentSecrets }, this.logger);
    Object.assign(call, answeredProblem(response));
    return forwardedAnswer(call.id, response);
  }

  private admissionFor(service: RegisteredService): OperationAdmissionGate {
    let admission = this.admissions.get(service.manifestHash);
    if (!admission) {
      admission = createOperationAdmission(service.manifest);
      this.admissions.set(service.manifestHash, admission);
    }
    return admission;
  }

  private wireCaller(caller: GateCaller, via: GateVia): WireContext['caller'] {
    return {
      tenantId: caller.tenantId,
      projectId: caller.projectId,
      environmentId: caller.projectEnvironmentId,
      environment: caller.environment,
      via,
    };
  }
}
