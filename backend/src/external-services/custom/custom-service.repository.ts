import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import { db } from '../../../db';
import { externalServices, projectEnvironments, projects } from '../../../db/schema';

export interface CustomServiceRow {
  id: string;
  tenantId: string;
  slug: string;
  name: string;
  builderChatId: string;
  defaultEnvironmentId: string | null;
  disabled: boolean;
  createdBy: string | null;
  createdAt: Date;
}

export interface NewCustomService {
  id: string;
  tenantId: string;
  slug: string;
  builderChatId: string;
  createdBy: string;
}

export const CUSTOM_SLUG_UNIQUE = 'external_services_tenant_id_slug_unique';

interface PostgresErrorFields {
  code?: string;
  constraint_name?: string;
}

export function isCustomSlugTaken(error: unknown): boolean {
  const direct = error as PostgresErrorFields & { cause?: unknown };
  const pg = direct?.code ? direct : ((direct?.cause as PostgresErrorFields | undefined) ?? {});
  return pg.code === '23505' && pg.constraint_name === CUSTOM_SLUG_UNIQUE;
}

const customColumns = {
  id: externalServices.id,
  tenantId: externalServices.tenantId,
  slug: externalServices.slug,
  title: projects.title,
  builderChatId: externalServices.builderChatId,
  defaultEnvironmentId: externalServices.defaultEnvironmentId,
  disabled: projects.disabled,
  createdBy: externalServices.createdBy,
  createdAt: externalServices.createdAt,
};

interface CustomColumns {
  id: string;
  tenantId: string | null;
  slug: string;
  title: string | null;
  builderChatId: string | null;
  defaultEnvironmentId: string | null;
  disabled: boolean;
  createdBy: string | null;
  createdAt: Date;
}

function customRowOf(row: CustomColumns): CustomServiceRow {
  return {
    id: row.id,
    tenantId: row.tenantId ?? '',
    slug: row.slug,
    name: row.title ?? row.slug,
    builderChatId: row.builderChatId ?? '',
    defaultEnvironmentId: row.defaultEnvironmentId,
    disabled: row.disabled,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}

@Injectable()
export class CustomServiceRepository {
  async slugInUse(tenantId: string, slug: string): Promise<'built_in' | 'custom' | null> {
    const [row] = await db
      .select({ tenantId: externalServices.tenantId })
      .from(externalServices)
      .where(
        and(
          eq(externalServices.slug, slug),
          or(isNull(externalServices.tenantId), eq(externalServices.tenantId, tenantId))
        )
      )
      .orderBy(asc(externalServices.tenantId))
      .limit(1);
    if (!row) return null;
    return row.tenantId === null ? 'built_in' : 'custom';
  }

  async insert(service: NewCustomService): Promise<void> {
    await db.insert(externalServices).values({ ...service, origin: 'custom' });
  }

  async findInTenant(tenantId: string, id: string): Promise<CustomServiceRow | null> {
    const [row] = await db
      .select(customColumns)
      .from(externalServices)
      .innerJoin(projects, eq(projects.id, externalServices.builderChatId))
      .where(and(eq(externalServices.id, id), eq(externalServices.tenantId, tenantId)));
    return row ? customRowOf(row) : null;
  }

  async findByBuilderChat(chatId: string): Promise<CustomServiceRow | null> {
    const [row] = await db
      .select(customColumns)
      .from(externalServices)
      .innerJoin(projects, eq(projects.id, externalServices.builderChatId))
      .where(eq(externalServices.builderChatId, chatId));
    return row ? customRowOf(row) : null;
  }

  async listForTenant(tenantId: string): Promise<CustomServiceRow[]> {
    const rows = await db
      .select(customColumns)
      .from(externalServices)
      .innerJoin(projects, eq(projects.id, externalServices.builderChatId))
      .where(eq(externalServices.tenantId, tenantId))
      .orderBy(asc(externalServices.slug));
    return rows.map(customRowOf);
  }

  async publishedEnvironmentIds(builderChatIds: string[]): Promise<Map<string, string[]>> {
    const published = new Map<string, string[]>();
    if (builderChatIds.length === 0) return published;
    const rows = await db
      .select({ builderChatId: projectEnvironments.projectId, environmentId: projectEnvironments.environmentId })
      .from(projectEnvironments)
      .where(
        and(
          inArray(projectEnvironments.projectId, builderChatIds),
          eq(projectEnvironments.isDefault, false),
          isNotNull(projectEnvironments.deployedCommitSha)
        )
      );
    for (const { builderChatId, environmentId } of rows) {
      if (!builderChatId || !environmentId) continue;
      published.set(builderChatId, [...(published.get(builderChatId) ?? []), environmentId]);
    }
    return published;
  }

  async renameSlugWhileUnpublished(tenantId: string, id: string, slug: string): Promise<boolean> {
    const renamed = await db
      .update(externalServices)
      .set({ slug, updatedAt: new Date() })
      .where(
        and(
          eq(externalServices.id, id),
          eq(externalServices.tenantId, tenantId),
          isNull(externalServices.defaultEnvironmentId)
        )
      )
      .returning({ id: externalServices.id });
    return renamed.length > 0;
  }
}
