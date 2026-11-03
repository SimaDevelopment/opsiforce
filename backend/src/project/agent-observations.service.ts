import { Injectable } from '@nestjs/common';
import type { AgentObservation, ObservedEnvironment } from './agent-observation';
import { AgentStatusService } from './agent-status.service';
import { ProjectService } from './project.service';
import { meaningfulTitle } from './session-title';

@Injectable()
export class AgentObservationsService {
  constructor(
    private readonly agentStatus: AgentStatusService,
    private readonly projects: ProjectService
  ) {}

  async observe(env: ObservedEnvironment, observation: AgentObservation): Promise<void> {
    const { kind, sessionId, root, requestId } = observation;
    switch (kind) {
      case 'run.started':
        return this.agentStatus.runStarted(env.projectId, env.environmentId, sessionId);
      case 'run.ended':
        return this.agentStatus.runEnded(env.projectId, env.environmentId, sessionId);
      case 'input.requested':
        if (typeof requestId === 'string' && requestId.length > 0) {
          this.agentStatus.inputRequested(env.projectId, env.environmentId, requestId);
        }
        return;
      case 'input.resolved':
        if (typeof requestId === 'string') this.agentStatus.inputResolved(env.projectId, env.environmentId, requestId);
        return;
      case 'prompted':
        if (root === true) await this.projects.stampLastPromptByEnvId(env.environmentId);
        return;
      case 'titled': {
        const title = meaningfulTitle(observation.title);
        if (root === true && title) await this.projects.nameAfterPrimarySession(env.environmentId, sessionId, title);
        return;
      }
      default:
        return;
    }
  }
}
