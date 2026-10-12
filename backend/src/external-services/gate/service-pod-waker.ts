export type ServicePodWakeState = 'ready' | 'starting' | 'disabled' | 'failed';

export abstract class ServicePodWaker {
  abstract wake(projectEnvironmentId: string): Promise<ServicePodWakeState>;
  abstract awaitServing(projectEnvironmentId: string, timeoutMs: number): Promise<boolean>;
}
