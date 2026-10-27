import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { environments, projectApps, projectEnvironments } from '../../db/schema';
import { toAppSlug, type AppSlugBudget } from '../common/app-slug';
import { signInCallbacksAreRegisteredOutside } from './app-auth-route';
import type { ProjectAppMeta, ProjectAuthMode } from './project.types';

interface StoredAppMeta {
  name: string | null;
  description: string | null;
  slug: string | null;
}

interface AppDetails {
  name: string | null;
  description: string | null;
}

export function appSlugOfNewApp(
  copiedFrom: { slug: string | null; name: string | null },
  target: AppSlugBudget & { authMode: ProjectAuthMode }
): string | null {
  if (signInCallbacksAreRegisteredOutside(target.authMode)) return null;
  return toAppSlug(copiedFrom.slug ?? copiedFrom.name, target);
}

@Injectable()
export class AppService {
  async get(projectEnvironmentId: string): Promise<ProjectAppMeta | null> {
    const row = await this.stored(projectEnvironmentId);
    if (!row) return null;
    return { exists: true, name: row.name, description: row.description };
  }

  async upsertProjectApp(projectEnvironmentId: string, projectId: string, details: AppDetails): Promise<boolean> {
    const existing = await this.stored(projectEnvironmentId);
    if (!existing) {
      if (await this.createApp(projectEnvironmentId, projectId, details)) return true;
    } else if (existing.name === details.name && existing.description === details.description) {
      return false;
    }

    await db
      .update(projectApps)
      .set({ name: details.name, description: details.description, updatedAt: new Date() })
      .where(eq(projectApps.projectEnvironmentId, projectEnvironmentId));
    return true;
  }

  private async createApp(projectEnvironmentId: string, projectId: string, details: AppDetails): Promise<boolean> {
    const created = await db
      .insert(projectApps)
      .values({
        projectEnvironmentId,
        projectId,
        name: details.name,
        description: details.description,
        slug: await this.appSlugAtGoLive(projectEnvironmentId, projectId, details.name),
      })
      .onConflictDoNothing()
      .returning({ projectEnvironmentId: projectApps.projectEnvironmentId });
    return created.length > 0;
  }

  private async appSlugAtGoLive(projectEnvironmentId: string, projectId: string, name: string | null) {
    const [target] = await db
      .select({
        environmentSlug: environments.slug,
        shortId: projectEnvironments.shortId,
        authMode: projectEnvironments.authMode,
      })
      .from(projectEnvironments)
      .leftJoin(environments, eq(environments.id, projectEnvironments.environmentId))
      .where(eq(projectEnvironments.id, projectEnvironmentId));
    if (!target) return null;

    const isPublishedEnvironment = projectEnvironmentId !== projectId;
    const development = isPublishedEnvironment ? await this.stored(projectId) : null;
    return appSlugOfNewApp({ slug: development?.slug ?? null, name }, target);
  }

  private async stored(projectEnvironmentId: string): Promise<StoredAppMeta | null> {
    const [row] = await db
      .select({ name: projectApps.name, description: projectApps.description, slug: projectApps.slug })
      .from(projectApps)
      .where(eq(projectApps.projectEnvironmentId, projectEnvironmentId));
    return row ?? null;
  }
}
