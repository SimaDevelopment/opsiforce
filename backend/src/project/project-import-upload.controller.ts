import { Body, Controller, Delete, HttpCode, Param, Post, Put, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { Readable } from 'node:stream';
import { ProjectImportUploadService } from './project-import-upload.service';
import type { CreateImportUploadDto, CreateImportUploadResult } from './project-import.types';
import { CurrentTenant, type TenantContext } from '../tenant/tenant.decorator';
import { RequireAnyPermission } from '../permission/permission.guard';
import { Perms } from '../permission/permission.constants';

const CHUNK_DIGEST_HEADER = 'x-chunk-sha256';
const IMPORT_UPLOAD_PERMISSIONS = [Perms.importProject, Perms.manageAgents];

interface ChunkRequest extends FastifyRequest {
  body: Readable;
}

@Controller('projects/import/uploads')
export class ProjectImportUploadController {
  constructor(private readonly uploadService: ProjectImportUploadService) {}

  @Post()
  @RequireAnyPermission(IMPORT_UPLOAD_PERMISSIONS)
  create(
    @CurrentTenant() tenant: TenantContext,
    @Body() dto: CreateImportUploadDto | undefined
  ): Promise<CreateImportUploadResult> {
    return this.uploadService.createSession(tenant.tenantId, dto?.size);
  }

  @Put(':uploadId/chunks/:index')
  @RequireAnyPermission(IMPORT_UPLOAD_PERMISSIONS)
  @HttpCode(204)
  async putChunk(
    @Param('uploadId') uploadId: string,
    @Param('index') index: string,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: ChunkRequest
  ): Promise<void> {
    await this.uploadService.writeChunk({
      tenantId: tenant.tenantId,
      uploadId,
      index,
      digestHeader: firstHeader(req.headers[CHUNK_DIGEST_HEADER]),
      contentLengthHeader: req.headers['content-length'],
      body: req.body,
    });
  }

  @Delete(':uploadId')
  @RequireAnyPermission(IMPORT_UPLOAD_PERMISSIONS)
  @HttpCode(204)
  async cancel(@Param('uploadId') uploadId: string, @CurrentTenant() tenant: TenantContext): Promise<void> {
    await this.uploadService.deleteSession({ tenantId: tenant.tenantId, uploadId });
  }
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
