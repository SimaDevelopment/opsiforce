import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PodService } from '../pod/pod.service';
import type { PodRequestInit } from '../pod/pod-fetch';

interface EnvironmentUpstreamRef {
  id: string;
}

@Injectable()
export class ProxyService {
  private readonly agentPort: number;
  private readonly appPort: number;
  private readonly vscodePort: number;
  private readonly dbViewerPort: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly podService: PodService
  ) {
    this.agentPort = this.configService.getOrThrow<number>('agentPort');
    this.appPort = this.configService.getOrThrow<number>('appPort');
    this.vscodePort = this.configService.getOrThrow<number>('vscodePort');
    this.dbViewerPort = this.configService.getOrThrow<number>('dbViewerPort');
  }

  resolveUpstreamForProject(env: EnvironmentUpstreamRef): string {
    return this.podService.podAddress(env.id, this.agentPort);
  }

  resolveAppUpstreamForProject(env: EnvironmentUpstreamRef): string {
    return this.podService.podAddress(env.id, this.appPort);
  }

  resolveVscodeUpstreamForProject(env: EnvironmentUpstreamRef): string {
    return this.podService.podAddress(env.id, this.vscodePort);
  }

  resolveDbUpstreamForProject(env: EnvironmentUpstreamRef): string {
    return this.podService.podAddress(env.id, this.dbViewerPort);
  }

  getAssignedPodName(environmentId: string): string {
    return this.podService.assignedPodName(environmentId);
  }

  fetchApp(environmentId: string, path: string, init?: PodRequestInit): Promise<Response> {
    return this.podService.podFetch(environmentId, this.appPort, path, init);
  }
}
