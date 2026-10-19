import { close, fsync, open } from 'node:fs';
import { access, mkdir, rename, rm } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { recordsFileInWorkspace, stateFileInWorkspace } from '@opsiforce/external-service-sdk/server';
import { and, eq, inArray } from 'drizzle-orm';
import { open as openSqlite } from 'sqlite';
import sqlite3 from 'sqlite3';
import { db } from '../../../db';
import { externalServices, projectEnvironments } from '../../../db/schema';
import { errorMessage } from '../../common/error-message';
import { openDatabaseFile } from '../../common/environment-database';

const RECORDS_COPY_ATTEMPTS = 8;
const RECORDS_COPY_RETRY_MS = 60;
const RECORDS_BUSY_CODES = new Set(['SQLITE_READONLY', 'SQLITE_BUSY', 'SQLITE_CORRUPT']);

@Injectable()
export class ServiceStateFiles {
  private readonly logger = new Logger(ServiceStateFiles.name);
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
    if (!from || !to) return;
    await copyStateFile(
      this.fileIn(from.directory, stateFileInWorkspace),
      this.fileIn(to.directory, stateFileInWorkspace)
    );
    await copyRecordsFile(
      this.fileIn(from.directory, recordsFileInWorkspace),
      this.fileIn(to.directory, recordsFileInWorkspace)
    ).catch((error) => {
      this.logger.warn(`The records file of service ${serviceId} stayed behind on its switch: ${errorMessage(error)}`);
    });
  }

  async remove(projectEnvironmentId: string): Promise<void> {
    const [environment] = await db
      .select({ directory: projectEnvironments.directory })
      .from(projectEnvironments)
      .where(eq(projectEnvironments.id, projectEnvironmentId));
    if (environment) await removeDatabaseFile(this.fileIn(environment.directory, stateFileInWorkspace));
  }

  private fileIn(directory: string, fileInWorkspace: string): string {
    return path.join(this.storageMountPath, directory, fileInWorkspace);
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

function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
}

async function copyStateFile(source: string, target: string): Promise<void> {
  if (!(await exists(source))) {
    await removeDatabaseFile(target);
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
  await landStaged(staged, target);
}

async function vacuumReadOnlyInto(source: string, staged: string): Promise<void> {
  const connection = await openSqlite({ filename: source, driver: sqlite3.Database, mode: sqlite3.OPEN_READONLY });
  try {
    await connection.run('VACUUM INTO ?', staged);
  } finally {
    await connection.close();
  }
}

async function copyRecordsFile(source: string, target: string): Promise<void> {
  if (!(await exists(source))) {
    await removeDatabaseFile(target);
    return;
  }
  const staged = `${target}.copying`;
  await mkdir(path.dirname(target), { recursive: true });
  for (let attempt = 1; ; attempt += 1) {
    await rm(staged, { force: true });
    try {
      await vacuumReadOnlyInto(source, staged);
      break;
    } catch (error) {
      const code = codeOf(error);
      if (code === undefined || !RECORDS_BUSY_CODES.has(code) || attempt >= RECORDS_COPY_ATTEMPTS) {
        await rm(staged, { force: true });
        throw error;
      }
      await sleep(RECORDS_COPY_RETRY_MS * attempt);
    }
  }
  await landStaged(staged, target);
}

async function landStaged(staged: string, target: string): Promise<void> {
  const descriptor = await promisify(open)(staged, 'r+');
  try {
    await promisify(fsync)(descriptor);
  } finally {
    await promisify(close)(descriptor);
  }
  await rm(`${target}-journal`, { force: true });
  await rename(staged, target);
}

async function removeDatabaseFile(file: string): Promise<void> {
  await Promise.all([rm(file, { force: true }), rm(`${file}-journal`, { force: true })]);
}
