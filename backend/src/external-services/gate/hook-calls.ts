import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { problem, type HookName } from '@opsiforce/external-service-sdk';
import { inputBytesOf } from '@opsiforce/external-service-sdk/platform';
import type { DeliveredHook } from '../configuration/configuration-delivery';
import type { RegisteredService } from '../registry/service-registry';
import { checkServiceAnswer } from './answer-checks';
import { DispatchContexts } from './dispatch-contexts';
import { CallLog, type CallRecord } from './call-log';
import { answeredAndLogged, answeredProblem, dispatchedOrRefused, openedOrRefused } from './service-answers';
import { ServiceDispatcher } from './service-dispatcher';

export interface HookCaller {
  tenantId: string;
  projectId: string;
  environmentId: string;
  environment: string;
  via: 'form';
}

export interface HookCall {
  service: RegisteredService;
  hook: HookName;
  deliver: () => DeliveredHook;
  caller?: HookCaller;
  record: Partial<CallRecord>;
}

export interface HookFailure {
  callId: string;
  code: string;
  detail: string | null;
}

export type HookOutcome = { kind: 'none' } | { kind: 'answered' } | ({ kind: 'failed' } & HookFailure);

const UNKNOWN_HANDLER = 'unknown-handler';

@Injectable()
export class HookCalls {
  private readonly logger = new Logger(HookCalls.name);

  constructor(
    private readonly dispatcher: ServiceDispatcher,
    private readonly callLog: CallLog,
    private readonly contexts: DispatchContexts
  ) {}

  declares(service: RegisteredService, hook: HookName): boolean {
    if (!this.dispatcher.runsInProcess(service)) return true;
    return service.runtime.health().handlers.hooks.includes(hook);
  }

  async call(request: HookCall): Promise<HookOutcome> {
    const { service, hook } = request;
    if (!this.declares(service, hook)) return { kind: 'none' };
    const call: CallRecord = {
      id: randomUUID(),
      kind: 'hook',
      via: null,
      externalServiceId: service.id,
      slug: service.slug,
      manifestHash: service.manifestHash,
      operation: hook,
      decision: 'refused',
      status: 0,
      durationMs: 0,
      ...request.record,
    };
    return answeredAndLogged(this.callLog, call, {
      answer: async () => {
        const delivered = openedOrRefused(this.logger, call.id, service, request.deliver);
        const body = {
          context: this.contexts.of(service, {
            callId: call.id,
            caller: request.caller,
            serviceConfiguration: delivered.serviceConfiguration,
          }),
          previous: delivered.previous,
          current: delivered.current,
        };
        call.inputBytes = inputBytesOf(body);
        call.decision = 'allowed';
        const response = await dispatchedOrRefused(service, () =>
          this.dispatcher.dispatch(service, { route: 'hooks', name: hook, body })
        );
        call.outputBytes = response.body.byteLength;
        checkServiceAnswer({ callId: call.id, service, response, sentSecrets: delivered.sentSecrets }, this.logger);
        Object.assign(call, answeredProblem(response));
        if (response.status === 404 && call.code === UNKNOWN_HANDLER) {
          return { answer: { kind: 'none' }, status: response.status, unlogged: true };
        }
        return { answer: outcomeOf(call, response.status), status: response.status };
      },
      refused: (refusal) => ({ answer: outcomeOf(call, refusal.status), status: refusal.status }),
      failed: (error) => {
        this.logger.error(`The ${hook} hook of "${service.slug}" failed in the platform`, (error as Error).stack);
        return problem({
          status: 500,
          code: 'gate-failed',
          detail: 'The platform failed while running the after-save hook.',
        });
      },
    });
  }
}

function outcomeOf(call: CallRecord, status: number): HookOutcome {
  if (status >= 200 && status < 300) return { kind: 'answered' };
  return { kind: 'failed', callId: call.id, code: call.code ?? 'service-failed', detail: call.detail ?? null };
}
