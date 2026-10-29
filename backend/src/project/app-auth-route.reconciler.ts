import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { errorMessage } from '../common/error-message';
import { ProjectEnvironmentService } from '../project-environment/project-environment.service';
import { ProjectAuthService } from './project-auth.service';

const REPLACED_REPLICAS_GONE_AFTER_MS = 5 * 60 * 1000;

@Injectable()
export class AppAuthRouteReconciler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(AppAuthRouteReconciler.name);
  private passAfterRollout: NodeJS.Timeout | undefined;

  constructor(
    private readonly projectEnvironments: ProjectEnvironmentService,
    private readonly projectAuth: ProjectAuthService
  ) {}

  onApplicationBootstrap(): void {
    this.reconcileInBackground();
    this.passAfterRollout = setTimeout(() => this.reconcileInBackground(), REPLACED_REPLICAS_GONE_AFTER_MS);
    this.passAfterRollout.unref();
  }

  onModuleDestroy(): void {
    clearTimeout(this.passAfterRollout);
  }

  async reconcileAll(): Promise<void> {
    const gated = await this.projectAuth.gatedRoutingIds();
    const protectedEnvironments = await this.projectEnvironments.listProtected();
    for (const env of protectedEnvironments) {
      try {
        await this.projectAuth.reconcileRoute(env);
      } catch (error) {
        this.logger.warn(`Failed to reconcile the App Auth route of environment ${env.id}: ${errorMessage(error)}`);
      }
    }
    const protectedIds = new Set(protectedEnvironments.map((env) => env.id));
    for (const routingId of gated.filter((id) => !protectedIds.has(id))) {
      try {
        await this.removeGateOfPublicEnvironment(routingId);
      } catch (error) {
        this.logger.warn(`Failed to remove the App Auth gate of environment ${routingId}: ${errorMessage(error)}`);
      }
    }
  }

  private async removeGateOfPublicEnvironment(routingId: string): Promise<void> {
    const env = await this.projectEnvironments.findByIdOrNull(routingId);
    if (env && env.authMode !== 'public') return;
    await this.projectAuth.remove(routingId);
    this.logger.log(`Removed the App Auth gate of environment ${routingId}, which is not protected`);
  }

  private reconcileInBackground(): void {
    this.reconcileAll().catch((error) => {
      this.logger.warn(`Failed to reconcile App Auth routes: ${errorMessage(error)}`);
    });
  }
}
