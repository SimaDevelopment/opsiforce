import { Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, isNotNull, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../../../db';
import { errorMessage } from '../../common/error-message';
import { externalServices, projectEnvironments, projects } from '../../../db/schema';
import { TEST_PROJECT_KIND } from '../../project/project.types';
import { PublishedServiceFilesReader, UnservableServiceFiles } from './published-service-files';
import type { RegisteredService } from './service-registry';

export type ServiceLane = 'default' | 'development';

export interface ServiceHome {
  builderChatId: string;
  environmentId: string;
  projectEnvironmentId: string;
  disabled: boolean;
  sdkVersion: string | null;
  lane: ServiceLane;
}

export interface TestedService {
  id: string;
  slug: string;
  tenantId: string;
  builderChatId: string;
}

export class UnservableCustomService extends Error {
  constructor(
    readonly slug: string,
    reason: string,
    readonly disabled: boolean
  ) {
    super(reason);
  }
}

export async function servableOrNone<T>(
  read: Promise<T>,
  onUnservable?: (error: UnservableCustomService) => void
): Promise<T | null> {
  try {
    return await read;
  } catch (error) {
    if (!(error instanceof UnservableCustomService)) throw error;
    onUnservable?.(error);
    return null;
  }
}

const publishedColumns = {
  id: externalServices.id,
  tenantId: externalServices.tenantId,
  slug: externalServices.slug,
  builderChatId: externalServices.builderChatId,
  environmentId: externalServices.defaultEnvironmentId,
  defaultEnvironmentId: externalServices.defaultEnvironmentId,
  projectEnvironmentId: projectEnvironments.id,
  directory: projectEnvironments.directory,
  disabled: projects.disabled,
};

type HomeRow = {
  id: string;
  tenantId: string | null;
  slug: string;
  builderChatId: string | null;
  environmentId: string | null;
  defaultEnvironmentId: string | null;
  projectEnvironmentId: string;
  directory: string;
  disabled: boolean;
};

function isCallersEnvironment(row: HomeRow, lane: ServiceLane): boolean {
  return lane === 'default' && row.environmentId !== null && row.environmentId === row.defaultEnvironmentId;
}

@Injectable()
export class CustomServiceCatalog {
  private readonly logger = new Logger(CustomServiceCatalog.name);

  private defaultFilesChanged: ((service: RegisteredService) => Promise<void>) | null = null;

  constructor(private readonly files: PublishedServiceFilesReader) {}

  whenDefaultFilesChange(listener: (service: RegisteredService) => Promise<void>): void {
    this.defaultFilesChanged = listener;
  }

  async bySlug(tenantId: string, slug: string): Promise<RegisteredService | null> {
    const [row] = await this.published(and(eq(externalServices.tenantId, tenantId), eq(externalServices.slug, slug)));
    return row ? this.registered(row) : null;
  }

  async byId(id: string): Promise<RegisteredService | null> {
    const [row] = await this.published(eq(externalServices.id, id));
    return row ? this.registered(row) : null;
  }

  async publishedAt(id: string, environmentId: string): Promise<RegisteredService | null> {
    const [row] = await db
      .select({ ...publishedColumns, environmentId: projectEnvironments.environmentId })
      .from(externalServices)
      .innerJoin(projects, eq(projects.id, externalServices.builderChatId))
      .innerJoin(
        projectEnvironments,
        and(
          eq(projectEnvironments.projectId, externalServices.builderChatId),
          eq(projectEnvironments.environmentId, environmentId),
          eq(projectEnvironments.isDefault, false)
        )
      )
      .where(and(eq(externalServices.origin, 'custom'), eq(externalServices.id, id)));
    return row ? this.registered(row) : null;
  }

  async listPublished(tenantId: string): Promise<RegisteredService[]> {
    const rows = await this.published(eq(externalServices.tenantId, tenantId));
    const services: RegisteredService[] = [];
    for (const row of rows) {
      try {
        services.push(await this.registered(row));
      } catch (error) {
        if (!(error instanceof UnservableCustomService)) throw error;
        this.logger.warn(`Custom External Service ${row.slug} (${row.id}) is left out: ${error.message}`);
      }
    }
    return services;
  }

  async development(id: string): Promise<RegisteredService | null> {
    const [row] = await db
      .select({ ...publishedColumns, environmentId: projectEnvironments.environmentId })
      .from(externalServices)
      .innerJoin(projects, eq(projects.id, externalServices.builderChatId))
      .innerJoin(
        projectEnvironments,
        and(eq(projectEnvironments.projectId, externalServices.builderChatId), eq(projectEnvironments.isDefault, true))
      )
      .where(and(eq(externalServices.origin, 'custom'), eq(externalServices.id, id)));
    if (!row) return null;
    return this.registered(row, 'development');
  }

  async testedBy(projectEnvironmentId: string): Promise<TestedService | null> {
    const testProject = alias(projects, 'test_project');
    const [row] = await db
      .select({
        id: externalServices.id,
        slug: externalServices.slug,
        tenantId: externalServices.tenantId,
        builderChatId: externalServices.builderChatId,
      })
      .from(projectEnvironments)
      .innerJoin(testProject, eq(testProject.id, projectEnvironments.projectId))
      .innerJoin(externalServices, eq(externalServices.builderChatId, testProject.createdByProjectId))
      .where(
        and(
          eq(projectEnvironments.id, projectEnvironmentId),
          eq(testProject.kind, TEST_PROJECT_KIND),
          eq(testProject.tenantId, externalServices.tenantId)
        )
      );
    if (!row?.tenantId || !row.builderChatId) return null;
    return { id: row.id, slug: row.slug, tenantId: row.tenantId, builderChatId: row.builderChatId };
  }

  async slugsOf(tenantId: string): Promise<Set<string>> {
    const rows = await db
      .select({ slug: externalServices.slug })
      .from(externalServices)
      .where(eq(externalServices.tenantId, tenantId));
    return new Set(rows.map((row) => row.slug));
  }

  private published(where: SQL | undefined): Promise<HomeRow[]> {
    return db
      .select(publishedColumns)
      .from(externalServices)
      .innerJoin(projects, eq(projects.id, externalServices.builderChatId))
      .innerJoin(
        projectEnvironments,
        and(
          eq(projectEnvironments.projectId, externalServices.builderChatId),
          eq(projectEnvironments.environmentId, externalServices.defaultEnvironmentId)
        )
      )
      .where(and(eq(externalServices.origin, 'custom'), isNotNull(externalServices.defaultEnvironmentId), where))
      .orderBy(asc(externalServices.slug));
  }

  private async registered(row: HomeRow, lane: ServiceLane = 'default'): Promise<RegisteredService> {
    let read;
    try {
      read = await this.files.read(row.directory);
    } catch (error) {
      if (error instanceof UnservableServiceFiles)
        throw new UnservableCustomService(row.slug, error.message, row.disabled);
      throw error;
    }
    const { files } = read;
    const service: RegisteredService = {
      id: row.id,
      slug: row.slug,
      origin: 'custom',
      tenantId: row.tenantId,
      manifest: files.manifest,
      manifestHash: files.manifestHash,
      icon: files.icon,
      serviceSkill: files.serviceSkill,
      runtime: null,
      home: {
        builderChatId: row.builderChatId ?? '',
        environmentId: row.environmentId ?? '',
        projectEnvironmentId: row.projectEnvironmentId,
        disabled: row.disabled,
        sdkVersion: files.sdkVersion,
        lane,
      },
    };
    if (read.changed && isCallersEnvironment(row, lane)) this.followDefaultFilesLater(service);
    return service;
  }

  private followDefaultFilesLater(service: RegisteredService): void {
    const listener = this.defaultFilesChanged;
    if (!listener) return;
    setImmediate(() => {
      listener(service).catch((error: unknown) => {
        this.logger.warn(`Following the new files of "${service.slug}" failed: ${errorMessage(error)}`);
      });
    });
  }
}
