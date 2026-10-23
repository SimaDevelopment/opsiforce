import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { BadRequestException, Body, Controller, Get, Param, Post, Res, UseFilters } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { contentDisposition } from '../../files/file-content-types';
import { RequirePermission } from '../../permission/permission.guard';
import { ProjectImportUploadService } from '../../project/project-import-upload.service';
import { CurrentTenant, type TenantContext } from '../../tenant/tenant.decorator';
import { CurrentUser, type UserContext } from '../../user/user.decorator';
import { UserService } from '../../user/user.service';
import { CustomServiceRefusalFilter } from './custom-service-refusal';
import type { CustomServiceCreator } from './custom-services.service';
import { ServiceCopies } from './service-copies';
import type { ImportServiceRequest, ServiceCopy, ServiceCopyRequest, ServiceExportPreview } from './service-export';

@Controller('external-services/services')
@RequirePermission('can_manage_tenant_external_services')
@UseFilters(CustomServiceRefusalFilter)
export class ServiceCopiesController {
  constructor(
    private readonly copies: ServiceCopies,
    private readonly uploads: ProjectImportUploadService,
    private readonly users: UserService
  ) {}

  @Post('import')
  async import(
    @Body() body: ImportServiceRequest | undefined,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<ServiceCopy> {
    const uploadId = typeof body?.uploadId === 'string' ? body.uploadId.trim() : '';
    if (!uploadId) throw new BadRequestException('An "uploadId" from a chunked upload session is required');

    const creator = await this.creator(tenant, user);
    const archivePath = join(this.uploads.stagingRoot(), `.service-import-${randomUUID()}.zip`);
    try {
      return await this.uploads.consumeUpload({ tenantId: tenant.tenantId, uploadId }, archivePath, () =>
        this.copies.importFrom(creator, archivePath, body ?? {})
      );
    } finally {
      await rm(archivePath, { force: true }).catch(() => {});
    }
  }

  @Post(':id/duplicate')
  async duplicate(
    @Param('id') id: string,
    @Body() body: ServiceCopyRequest | undefined,
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserContext
  ): Promise<ServiceCopy> {
    return this.copies.duplicate(await this.creator(tenant, user), id, body ?? {});
  }

  @Get(':id/export')
  async export(
    @Param('id') id: string,
    @Res() reply: FastifyReply,
    @CurrentTenant() tenant: TenantContext
  ): Promise<void> {
    const exported = await this.copies.exportFile(tenant.tenantId, id);
    await reply
      .header('Content-Type', 'application/zip')
      .header('Content-Length', exported.archive.byteLength)
      .header('Content-Disposition', contentDisposition(exported.fileName, 'attachment'))
      .header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .send(exported.archive);
  }

  @Get(':id/export/preview')
  exportPreview(@Param('id') id: string, @CurrentTenant() tenant: TenantContext): Promise<ServiceExportPreview> {
    return this.copies.preview(tenant.tenantId, id);
  }

  private async creator(tenant: TenantContext, user: UserContext): Promise<CustomServiceCreator> {
    return { tenantId: tenant.tenantId, userId: await this.users.resolveUserId(user, tenant.tenantId) };
  }
}
