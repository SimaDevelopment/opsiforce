import { join } from 'node:path';
import type { ServiceManifest } from '@opsiforce/external-service-sdk';
import { eq } from 'drizzle-orm';
import { db } from '../../../db';
import { projectEnvironments } from '../../../db/schema';
import { SERVICE_APP_FOLDER } from '../registry/published-service-files';
import { readConfinedServiceFolder } from '../registry/service-folder-files';

export interface ServiceInstance {
  id: string;
  environmentId: string | null;
  isDefault: boolean;
  directory: string;
  deployedCommitSha: string | null;
}

export function serviceInstancesOf(builderChatId: string): Promise<ServiceInstance[]> {
  return db
    .select({
      id: projectEnvironments.id,
      environmentId: projectEnvironments.environmentId,
      isDefault: projectEnvironments.isDefault,
      directory: projectEnvironments.directory,
      deployedCommitSha: projectEnvironments.deployedCommitSha,
    })
    .from(projectEnvironments)
    .where(eq(projectEnvironments.projectId, builderChatId));
}

export function serviceAppFolder(storageMountPath: string, directory: string): string {
  return join(storageMountPath, directory, SERVICE_APP_FOLDER);
}

export async function manifestIn(storageMountPath: string, directory: string): Promise<ServiceManifest | null> {
  const { check } = await readConfinedServiceFolder(serviceAppFolder(storageMountPath, directory));
  return check.manifest ?? null;
}
