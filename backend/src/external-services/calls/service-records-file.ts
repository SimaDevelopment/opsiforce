import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { recordsFileInWorkspace } from '@opsiforce/external-service-sdk/server';
import { and, eq } from 'drizzle-orm';
import { type Database, open } from 'sqlite';
import sqlite3 from 'sqlite3';
import { db } from '../../../db';
import { externalServices, projectEnvironments } from '../../../db/schema';

const READ_ATTEMPTS = 5;
const RETRY_DELAY_MS = 60;

const RETRIED_CODES = new Set(['SQLITE_READONLY', 'SQLITE_CORRUPT', 'SQLITE_BUSY']);
const NOTHING_WRITTEN_CODES = new Set(['SQLITE_CANTOPEN']);

export class RecordsBusy extends Error {
  constructor() {
    super('The records are busy; reload.');
  }
}

export class RecordsUnreadable extends Error {}

function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
}

function isMissingTable(error: unknown): boolean {
  return codeOf(error) === 'SQLITE_ERROR' && error instanceof Error && error.message.includes('no such table');
}

async function readOnce<Result>(file: string, read: (database: Database) => Promise<Result>): Promise<Result> {
  const database = await open({ filename: file, driver: sqlite3.Database, mode: sqlite3.OPEN_READONLY });
  try {
    await database.exec('BEGIN');
    try {
      return await read(database);
    } finally {
      await database.exec('COMMIT').catch(() => undefined);
    }
  } finally {
    await database.close();
  }
}

export async function readServiceRecords<Result>(
  file: string,
  read: (database: Database) => Promise<Result>,
  nothingWritten: Result
): Promise<Result> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await readOnce(file, read);
    } catch (error) {
      const code = codeOf(error);
      if ((code !== undefined && NOTHING_WRITTEN_CODES.has(code)) || isMissingTable(error)) return nothingWritten;
      if (code === undefined || !RETRIED_CODES.has(code)) {
        throw new RecordsUnreadable(error instanceof Error ? error.message : String(error));
      }
      if (attempt >= READ_ATTEMPTS) throw new RecordsBusy();
      await sleep(RETRY_DELAY_MS * attempt);
    }
  }
}

export type ServiceCopy = 'default' | 'development';

const SERVICE_COPIES: readonly ServiceCopy[] = ['default', 'development'];

export function parseServiceCopy(value: unknown): ServiceCopy {
  if (value === undefined || value === '') return 'default';
  if (typeof value !== 'string' || !SERVICE_COPIES.includes(value as ServiceCopy)) {
    throw new BadRequestException(`"copy" must be one of ${SERVICE_COPIES.join(', ')}`);
  }
  return value as ServiceCopy;
}

export interface ServiceRecordsHome {
  file: string;
  podState: string;
}

@Injectable()
export class ServiceRecordsHomes {
  private readonly storageMountPath: string;

  constructor(config: ConfigService) {
    this.storageMountPath = config.getOrThrow<string>('storageMountPath');
  }

  async of(tenantId: string, serviceId: string, copy: ServiceCopy): Promise<ServiceRecordsHome | null> {
    const builderChatId = await this.builderChatOf(tenantId, serviceId);
    if (builderChatId === null) return null;
    const lane =
      copy === 'development'
        ? eq(projectEnvironments.isDefault, true)
        : and(
            eq(projectEnvironments.environmentId, externalServices.defaultEnvironmentId),
            eq(projectEnvironments.isDefault, false)
          );
    const [home] = await db
      .select({ directory: projectEnvironments.directory, status: projectEnvironments.status })
      .from(externalServices)
      .innerJoin(projectEnvironments, and(eq(projectEnvironments.projectId, builderChatId), lane))
      .where(eq(externalServices.id, serviceId));
    return home
      ? { file: path.join(this.storageMountPath, home.directory, recordsFileInWorkspace), podState: home.status }
      : null;
  }

  async read<Result>(
    home: ServiceRecordsHome,
    read: (database: Database) => Promise<Result>,
    nothingWritten: Result
  ): Promise<Result> {
    try {
      return await readServiceRecords(home.file, read, nothingWritten);
    } catch (error) {
      if (error instanceof RecordsBusy) {
        throw new ServiceUnavailableException({ code: 'records-busy', message: error.message });
      }
      if (error instanceof RecordsUnreadable) {
        throw new BadGatewayException({
          code: 'records-unreadable',
          message: `The service's records can't be read: ${error.message}`,
          podState: home.podState,
        });
      }
      throw error;
    }
  }

  private async builderChatOf(tenantId: string, serviceId: string): Promise<string | null> {
    const [service] = await db
      .select({ tenantId: externalServices.tenantId, builderChatId: externalServices.builderChatId })
      .from(externalServices)
      .where(eq(externalServices.id, serviceId));
    if (!service || (service.tenantId !== null && service.tenantId !== tenantId)) {
      throw new NotFoundException(`No External Service ${serviceId}`);
    }
    return service.builderChatId;
  }
}
