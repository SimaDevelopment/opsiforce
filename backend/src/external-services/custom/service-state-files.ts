import { close, fsync, open } from 'node:fs';
import { access, mkdir, rename, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { stateFileInWorkspace } from '@opsiforce/external-service-sdk/server';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../../db';
import { externalServices, projectEnvironments } from '../../../db/schema';
import { openDatabaseFile } from '../../common/environment-database';

@Injectable()
export class ServiceStateFiles {
  private readonly storageMountPath: string;

  constructor(config: ConfigService) {
    this.storageMountPath = config.getOrThrow<string>('storageMountPath');
  }

  async copyDefaultTo(serviceId: string, environmentId: string): Promise<void> {
    const [service] = await db
      .select({
        builderChatId: externalServices.builderChatId,
        defaultEnvironmentId: externalServices.defaultEnvironmentId,
      })
      .from(externalServices)
      .where(eq(externalServices.id, serviceId));
    if (!service?.builderChatId || !service.defaultEnvironmentId || service.defaultEnvironmentId === environmentId) {
      return;
    }
    const environments = await db
      .select({ environmentId: projectEnvironments.environmentId, directory: projectEnvironments.directory })
      .from(projectEnvironments)
      .where(
        and(
          eq(projectEnvironments.projectId, service.builderChatId),
          inArray(projectEnvironments.environmentId, [service.defaultEnvironmentId, environmentId])
        )
      );
    const from = environments.find((environment) => environment.environmentId === service.defaultEnvironmentId);
    const to = environments.find((environment) => environment.environmentId === environmentId);
    if (from && to) await copyStateFile(this.fileIn(from.directory), this.fileIn(to.directory));
  }

  async remove(projectEnvironmentId: string): Promise<void> {
    const [environment] = await db
      .select({ directory: projectEnvironments.directory })
      .from(projectEnvironments)
      .where(eq(projectEnvironments.id, projectEnvironmentId));
    if (environment) await removeStateFile(this.fileIn(environment.directory));
  }

  private fileIn(directory: string): string {
    return path.join(this.storageMountPath, directory, stateFileInWorkspace);
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function copyStateFile(source: string, target: string): Promise<void> {
  if (!(await exists(source))) {
    await removeStateFile(target);
    return;
  }
  const staged = `${target}.copying`;
  await mkdir(path.dirname(target), { recursive: true });
  await rm(staged, { force: true });
  const connection = await openDatabaseFile(source, {});
  try {
    await connection.run('VACUUM INTO ?', staged);
  } finally {
    await connection.close();
  }
  const descriptor = await promisify(open)(staged, 'r+');
  try {
    await promisify(fsync)(descriptor);
  } finally {
    await promisify(close)(descriptor);
  }
  await rm(`${target}-journal`, { force: true });
  await rename(staged, target);
}

async function removeStateFile(file: string): Promise<void> {
  await Promise.all([rm(file, { force: true }), rm(`${file}-journal`, { force: true })]);
}
