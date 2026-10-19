import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { DeliveredHook } from '../configuration/configuration-delivery';
import type { RegisteredService } from '../registry/service-registry';
import { checkServiceAnswer } from './answer-checks';
import { GateRefusal } from './gate-refusals';
import { answeredProblem, dispatchedOrRefused, openedOrRefused, platformFailed } from './service-answers';
import { ServiceDispatcher, type PlatformCallTarget } from './service-dispatcher';

export type HookName = 'onServiceConfigurationSaved' | 'onProjectConfigurationSaved';

export interface HookCall {
  service: RegisteredService;
  hook: HookName;
  deliver: () => DeliveredHook;
  for?: PlatformCallTarget;
}

export interface HookFailure {
  callId: string;
  code: string;
  detail: string | null;
}

export type HookOutcome = { kind: 'answered' } | ({ kind: 'failed' } & HookFailure);

function failed(callId: string, code: string | null, detail: string | null | undefined): HookOutcome {
  return { kind: 'failed', callId, code: code ?? 'service-failed', detail: detail ?? null };
}

@Injectable()
export class HookCalls {
  private readonly logger = new Logger(HookCalls.name);

  constructor(private readonly dispatcher: ServiceDispatcher) {}

  async call(request: HookCall): Promise<HookOutcome> {
    const { service, hook } = request;
    const callId = randomUUID();
    try {
      const delivered = openedOrRefused(this.logger, callId, service, request.deliver);
      const response = await dispatchedOrRefused(service, () =>
        this.dispatcher.dispatch(service, {
          route: 'hooks',
          name: hook,
          body: { previous: delivered.previous, current: delivered.current },
          ...(request.for ? { for: request.for } : {}),
        })
      );
      checkServiceAnswer({ callId, service, response }, this.logger);
      if (response.status >= 200 && response.status < 300) return { kind: 'answered' };
      const answered = answeredProblem(service, response);
      return failed(callId, answered.code, answered.detail);
    } catch (error) {
      if (error instanceof GateRefusal) return failed(callId, error.refusal.code, error.refusal.detail);
      const problem = platformFailed(this.logger, callId, error);
      return failed(callId, problem.code, problem.detail);
    }
  }
}
