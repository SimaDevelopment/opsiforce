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
    for (const env of await this.projectEnvironments.listProtected()) {
      try {
        await this.projectAuth.reconcileRoute(env);
      } catch (error) {
        this.logger.warn(`Failed to reconcile the App Auth route of environment ${env.id}: ${errorMessage(error)}`);
      }
    }
  }

  private reconcileInBackground(): void {
    this.reconcileAll().catch((error) => {
      this.logger.warn(`Failed to reconcile App Auth routes: ${errorMessage(error)}`);
    });
  }
}
