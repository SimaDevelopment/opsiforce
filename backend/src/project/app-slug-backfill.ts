import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { and, eq, isNull, not } from 'drizzle-orm';
import { db } from '../../db';
import { environments, projectApps, projectEnvironments } from '../../db/schema';
import { toAppSlug } from '../common/app-slug';
import { errorMessage } from '../common/error-message';
import { servesAnExternalService } from '../external-services/gate/service-projects';
import { signInCallbacksAreRegisteredOutside } from './app-auth-route';

// TODO: remove in the release after readable Public URLs ship: one-time App Slug backfill, a no-op once every deployment has booted it twice (the second boot catches Apps an older replica took live during the rollout)
@Injectable()
export class AppSlugBackfill implements OnApplicationBootstrap {
  private readonly logger = new Logger(AppSlugBackfill.name);

  onApplicationBootstrap(): void {
    this.run().catch((error) => {
      this.logger.warn(`Failed to give existing Apps an App Slug: ${errorMessage(error)}`);
    });
  }

  async run(): Promise<string[]> {
    const slugless = await db
      .select({
        projectEnvironmentId: projectApps.projectEnvironmentId,
        name: projectApps.name,
        authMode: projectEnvironments.authMode,
        environmentSlug: environments.slug,
        shortId: projectEnvironments.shortId,
      })
      .from(projectApps)
      .innerJoin(projectEnvironments, eq(projectEnvironments.id, projectApps.projectEnvironmentId))
      .innerJoin(environments, eq(environments.id, projectEnvironments.environmentId))
      .where(and(isNull(projectApps.slug), not(servesAnExternalService)));

    const switched: string[] = [];
    for (const app of slugless) {
      if (signInCallbacksAreRegisteredOutside(app.authMode)) continue;
      try {
        const updated = await db
          .update(projectApps)
          .set({ slug: toAppSlug(app.name, app) })
          .where(and(eq(projectApps.projectEnvironmentId, app.projectEnvironmentId), isNull(projectApps.slug)))
          .returning({ projectEnvironmentId: projectApps.projectEnvironmentId });
        switched.push(...updated.map((row) => row.projectEnvironmentId));
      } catch (error) {
        this.logger.warn(
          `Failed to give the App of environment ${app.projectEnvironmentId} an App Slug: ${errorMessage(error)}`
        );
      }
    }
    if (switched.length > 0) this.logger.log(`Gave ${switched.length} existing Apps an App Slug`);
    return switched;
  }
}
