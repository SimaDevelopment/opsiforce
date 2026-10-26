import { BadRequestException, Body, Controller, Get, Post } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { WORKSPACE_CLEANUP_QUEUE, type WorkspaceCleanupJobData } from '../cleanup/workspace-cleanup.processor';
import { RequirePermission } from '../permission/permission.guard';
import { PlatformScope } from '../tenant/tenant.decorator';
import { PlatformStorageService } from './platform-storage.service';
import type { PlatformStorageView } from './platform-storage.types';

@Controller('platform/storage')
export class PlatformStorageController {
  constructor(
    private readonly platformStorageService: PlatformStorageService,
    @InjectQueue(WORKSPACE_CLEANUP_QUEUE) private readonly workspaceCleanupQueue: Queue<WorkspaceCleanupJobData>
  ) {}

  @Get()
  @PlatformScope()
  @RequirePermission('can_view_platform_storage')
  snapshot(): Promise<PlatformStorageView> {
    return this.platformStorageService.snapshot();
  }

  @Post('cleanup')
  @PlatformScope()
  @RequirePermission('can_manage_platform_storage')
  async cleanup(@Body() body: { tenantId?: string }): Promise<{ enqueued: boolean }> {
    if (typeof body?.tenantId !== 'string' || body.tenantId.length === 0) {
      throw new BadRequestException('tenantId is required');
    }
    await this.workspaceCleanupQueue.add('cleanup', { tenantId: body.tenantId, ignoreRetention: true });
    return { enqueued: true };
  }
}
