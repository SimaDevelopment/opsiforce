import { Injectable } from '@nestjs/common';
import { AppReadinessService } from '../../project/app-readiness.service';
import { ProjectService } from '../../project/project.service';
import { ServicePodWaker, type ServicePodWakeState } from '../gate/service-pod-waker';

@Injectable()
export class ProjectPodWaker extends ServicePodWaker {
  constructor(
    private readonly projects: ProjectService,
    private readonly appReadiness: AppReadinessService
  ) {
    super();
  }

  async wake(projectEnvironmentId: string): Promise<ServicePodWakeState> {
    const ensured = await this.projects.ensureEnvironmentById(projectEnvironmentId, 'app');
    return ensured.state;
  }

  awaitServing(projectEnvironmentId: string, timeoutMs: number): Promise<boolean> {
    return this.appReadiness.awaitReady(projectEnvironmentId, timeoutMs);
  }
}
