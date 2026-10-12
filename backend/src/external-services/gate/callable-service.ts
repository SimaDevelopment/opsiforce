import { UnservableCustomService } from '../registry/custom-service-catalog';
import type { RegisteredService, ServiceRegistry } from '../registry/service-registry';
import { GateRefusal, refuseDisabledService, unknownServiceProblem, unservableServiceProblem } from './gate-refusals';

export async function resolveCallable(
  registry: ServiceRegistry,
  caller: { tenantId: string; projectEnvironmentId: string },
  slug: string
): Promise<RegisteredService> {
  let service: RegisteredService | undefined;
  try {
    service = await registry.forEnvironment(caller.tenantId, caller.projectEnvironmentId, slug);
  } catch (error) {
    if (!(error instanceof UnservableCustomService)) throw error;
    throw new GateRefusal(unservableServiceProblem(error));
  }
  if (!service) throw new GateRefusal(unknownServiceProblem(slug));
  if (service.home?.disabled) refuseDisabledService(slug);
  return service;
}
