import { BadRequestException, UnprocessableEntityException } from '@nestjs/common';
import type { ExportManifestStamp } from '../../export/project-export.types';
import type { KeyLikeHit } from '../../store/gate';
import type { CustomServiceSummary } from './custom-service-summary';

export const SERVICE_EXPORT_KIND = 'external-service';
export const SERVICE_EXPORT_FORMAT_VERSION = 1;

export interface ServiceExportStamp extends ExportManifestStamp {
  sdkVersion: string | null;
}

export interface ServiceExportManifest {
  kind: typeof SERVICE_EXPORT_KIND;
  stamp: ServiceExportStamp;
  service: { name: string; slug: string };
}

export interface ServiceExportFile {
  fileName: string;
  archive: Buffer;
}

export interface ServiceExportPreview {
  hits: KeyLikeHit[];
}

export interface ServiceCopyRequest {
  name?: unknown;
  slug?: unknown;
}

export interface ImportServiceRequest extends ServiceCopyRequest {
  uploadId?: unknown;
  fileName?: unknown;
}

export interface ServiceCopy {
  service: CustomServiceSummary;
  warnings: string[];
}

export interface ServiceImportProblem {
  path: string;
  message: string;
}

export function serviceExportFileName(slug: string): string {
  return `${slug}-service-export.zip`;
}

export function notAServiceExport(message: string): BadRequestException {
  return new BadRequestException({ code: 'not_a_service_export', message });
}

export function serviceImportRefused(problems: ServiceImportProblem[]): UnprocessableEntityException {
  return new UnprocessableEntityException({
    code: 'import_refused',
    message: `${problems.length} problem(s) stop this import; nothing was written`,
    problems,
  });
}
