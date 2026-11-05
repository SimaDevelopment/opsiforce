import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnApplicationShutdown } from '@nestjs/common';
import { Job } from 'bullmq';
import { ProjectEnvironmentService } from '../project-environment/project-environment.service';
import { ProjectService } from '../project/project.service';
import { ProjectStatus } from '../project/project.types';
import { RESOURCE_PRESET_RESTART_QUEUE, type PresetRestartJobData } from './resource-preset.types';

const RESTARTABLE = new Set<ProjectStatus>([ProjectStatus.Active, ProjectStatus.Starting]);

@Processor(RESOURCE_PRESET_RESTART_QUEUE, { concurrency: 1 })
export class ResourcePresetRestartProcessor extends WorkerHost implements OnApplicationShutdown {
  private readonly logger = new Logger(ResourcePresetRestartProcessor.name);

  constructor(
    private readonly projectService: ProjectService,
    private readonly projectEnvironments: ProjectEnvironmentService
  ) {
    super();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker.close();
  }

  async process(job: Job<PresetRestartJobData>): Promise<void> {
    const env = await this.projectEnvironments.findByIdOrNull(job.data.projectEnvironmentId);
    if (!env || !RESTARTABLE.has(env.status)) return;
    this.logger.log(`Restarting ${env.id} to apply new Resources`);
    await this.projectService.reassignPodById(env.id);
  }
}
