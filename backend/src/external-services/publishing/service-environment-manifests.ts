import { join } from 'node:path';
import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ServiceManifest } from '@opsiforce/external-service-sdk';
import { EnvironmentService } from '../../environment/environment.service';
import { GitService } from '../../git/git.service';
import { CustomServiceRepository } from '../custom/custom-service.repository';
import { SERVICE_APP_FOLDER } from '../registry/published-service-files';
import { manifestDiff, type ManifestDiff } from './manifest-diff';
import { manifestIn, serviceInstancesOf, type ServiceInstance } from './service-instances';

export type EnvironmentManifestStatus = 'development' | 'same-as-development' | 'development-differs' | 'unpublished';

export interface EnvironmentManifestView {
  environmentId: string;
  name: string;
  status: EnvironmentManifestStatus;
  serviceDefault: boolean;
  publishedCommitSha: string | null;
  manifest: ServiceManifest | null;
  changes: ManifestDiff | null;
}

type ReadEnvironment = Omit<EnvironmentManifestView, 'changes'>;

const APP_PATH_PREFIX = `${SERVICE_APP_FOLDER}/`;

@Injectable()
export class ServiceEnvironmentManifests {
  private readonly storageMountPath: string;

  constructor(
    config: ConfigService,
    private readonly repository: CustomServiceRepository,
    private readonly environments: EnvironmentService,
    private readonly git: GitService
  ) {
    this.storageMountPath = config.getOrThrow<string>('storageMountPath');
  }

  async of(tenantId: string, id: string): Promise<EnvironmentManifestView[]> {
    const service = await this.repository.findInTenant(tenantId, id);
    if (!service) throw new NotFoundException(`External Service ${id} not found`);
    const [registry, instances] = await Promise.all([
      this.environments.listForTenant(tenantId),
      serviceInstancesOf(service.builderChatId),
    ]);
    const development = instances.find((instance) => instance.isDefault);
    if (!development) throw new NotFoundException(`The builder chat ${service.builderChatId} has no Development`);

    const read = await Promise.all(
      registry.map(async (environment): Promise<ReadEnvironment> => {
        const instance = environment.isDefault
          ? development
          : instances.find((candidate) => candidate.environmentId === environment.id && !candidate.isDefault);
        const publishedCommitSha = environment.isDefault ? null : (instance?.deployedCommitSha ?? null);
        return {
          environmentId: environment.id,
          name: environment.name,
          status: environment.isDefault ? 'development' : await this.statusOf(development, publishedCommitSha),
          serviceDefault: service.defaultEnvironmentId === environment.id,
          publishedCommitSha,
          manifest:
            instance && (environment.isDefault || publishedCommitSha !== null)
              ? await manifestIn(this.storageMountPath, instance.directory)
              : null,
        };
      })
    );
    const callers = read.find((environment) => environment.serviceDefault)?.manifest ?? null;
    return read.map((environment) => ({
      ...environment,
      changes:
        callers && environment.manifest && !environment.serviceDefault
          ? manifestDiff(callers, environment.manifest)
          : null,
    }));
  }

  private async statusOf(
    development: ServiceInstance,
    publishedCommitSha: string | null
  ): Promise<EnvironmentManifestStatus> {
    if (publishedCommitSha === null) return 'unpublished';
    const changed = await this.git
      .changedSince(join(this.storageMountPath, development.directory), publishedCommitSha)
      .catch(() => null);
    return changed !== null && !changed.some((path) => path.startsWith(APP_PATH_PREFIX))
      ? 'same-as-development'
      : 'development-differs';
  }
}
