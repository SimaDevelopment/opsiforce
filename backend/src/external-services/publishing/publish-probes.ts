import { Injectable } from '@nestjs/common';
import { callerIdentityHeader, mintCallerIdentity } from '@opsiforce/external-service-sdk/server';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { db } from '../../../db';
import { externalServiceProjectConfigs, projectEnvironments } from '../../../db/schema';
import { GatewayKeyService } from '../../gateway/gateway-key.service';
import { CustomServiceRefusal } from '../custom/custom-service-refusal';
import { GateCallers } from '../gate/gate-caller';
import { ServicePods, UnreachablePod, type ServicePod } from '../gate/service-pods';
import type { RegisteredService } from '../registry/service-registry';

export const PUBLISH_PROBE_TIMEOUT_MS = 10_000;

const OUTCOME_HEADER = 'opsiforce-outcome';

const SDK_GUARD_HINT =
  'Serve the service with the SDK (`external-service-cli serve`) so its guard answers before any Service route.';

interface ProbeAnswer {
  status: number;
  outcome: string | null;
}

interface Probe {
  asked: string;
  expected: ProbeAnswer;
  headers: Record<string, string>;
}

function described(answer: ProbeAnswer): string {
  return `${answer.status} with ${answer.outcome === null ? 'no Opsiforce-Outcome header' : `Opsiforce-Outcome: ${answer.outcome}`}`;
}

function blocked(message: string): CustomServiceRefusal {
  return new CustomServiceRefusal(409, 'probe-failed', message);
}

@Injectable()
export class PublishProbes {
  constructor(
    private readonly pods: ServicePods,
    private readonly keys: GatewayKeyService,
    private readonly callers: GateCallers
  ) {}

  async assertGuarded(development: RegisteredService): Promise<void> {
    const pod = await this.reach(development);
    const podKey = await this.keys.getEnvironmentToken(pod.projectEnvironmentId);
    if (!podKey) throw blocked('Publish is blocked: Development has no Gateway Key to call it with.');
    await this.expect(pod, {
      asked: 'a request with no Caller identity',
      expected: { status: 401, outcome: 'unidentified' },
      headers: {},
    });
    const unconnected = await this.unconnectedCaller(development);
    await this.expect(pod, {
      asked: 'a call from a ProjectEnvironment with no Project configuration',
      expected: { status: 403, outcome: 'not connected' },
      headers: {
        [callerIdentityHeader]: mintCallerIdentity(
          {
            kind: 'call',
            tenantId: unconnected.tenantId,
            projectId: unconnected.projectId,
            projectEnvironmentId: unconnected.projectEnvironmentId,
            environment: unconnected.environment,
          },
          podKey
        ),
      },
    });
  }

  private async reach(development: RegisteredService): Promise<ServicePod> {
    if (!development.home) throw blocked('Publish is blocked: Development has no pod to check.');
    try {
      return await this.pods.reach(development.home);
    } catch (error) {
      if (!(error instanceof UnreachablePod)) throw error;
      throw blocked(
        `Publish is blocked: Development could not be checked (${error.message}). Start it in the builder chat and publish again.`
      );
    }
  }

  private async expect(pod: ServicePod, probe: Probe): Promise<void> {
    let answer: ProbeAnswer;
    try {
      const res = await fetch(`${pod.url}/`, {
        headers: probe.headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(PUBLISH_PROBE_TIMEOUT_MS),
      });
      await res.body?.cancel();
      answer = { status: res.status, outcome: res.headers.get(OUTCOME_HEADER) };
    } catch (error) {
      throw blocked(
        `Publish is blocked: Development did not answer ${probe.asked} (${error instanceof Error ? error.message : String(error)}). Start it in the builder chat and publish again.`
      );
    }
    if (answer.status === probe.expected.status && answer.outcome === probe.expected.outcome) return;
    throw blocked(
      `Publish is blocked: Development answered ${probe.asked} with ${described(answer)}; it must refuse it with ${described(probe.expected)}. ${SDK_GUARD_HINT}`
    );
  }

  private async unconnectedCaller(development: RegisteredService) {
    const candidates = await db
      .select({ id: projectEnvironments.id })
      .from(projectEnvironments)
      .leftJoin(
        externalServiceProjectConfigs,
        and(
          eq(externalServiceProjectConfigs.projectEnvironmentId, projectEnvironments.id),
          eq(externalServiceProjectConfigs.externalServiceId, development.id)
        )
      )
      .where(
        and(
          eq(projectEnvironments.projectId, development.home?.builderChatId ?? ''),
          isNull(externalServiceProjectConfigs.id)
        )
      )
      .orderBy(desc(projectEnvironments.isDefault), asc(projectEnvironments.id));
    for (const candidate of candidates) {
      const caller = await this.callers.byProjectEnvironment(development.tenantId ?? '', candidate.id);
      if (caller) return caller;
    }
    throw blocked('Publish is blocked: no ProjectEnvironment without a Project configuration is left to probe with.');
  }
}
