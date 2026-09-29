import type { PodClass } from '../pod/pod-classes';
import type { RequestLogMode } from '../project/project.types';

export const PROJECT_EXPORT_QUEUE = 'project-export';

export const EXPORT_FORMAT_VERSION = 1;

export const ProjectExportStatus = {
  Queued: 'queued',
  Committing: 'committing',
  Staging: 'staging',
  Archiving: 'archiving',
  Completed: 'completed',
  Failed: 'failed',
} as const;

export type ProjectExportStatus = (typeof ProjectExportStatus)[keyof typeof ProjectExportStatus];

export const ACTIVE_EXPORT_STATUSES: ProjectExportStatus[] = [
  ProjectExportStatus.Queued,
  ProjectExportStatus.Committing,
  ProjectExportStatus.Staging,
  ProjectExportStatus.Archiving,
];

export interface ProjectExportJobData {
  exportJobId: string;
  projectId: string;
  tenantId: string;
}

export interface ProjectExportJobResponse {
  id: string;
  projectId: string;
  status: ProjectExportStatus;
  bytesTotal: number;
  bytesProcessed: number;
  fileName: string | null;
  fileSize: number | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExportManifestStamp {
  exportFormatVersion: number;
  platformVersion: string;
  agentImageVersion: string;
  arch: string;
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface ExportManifestSettings {
  timeoutIdle: number;
  appTimeoutIdle: number;
  requestLogMode: RequestLogMode;
  requestLogBodyLimit: number;
}

export interface ExportManifestResources {
  podClass: PodClass;
  cpuMillicores: number;
  memoryRequestMib: number;
  memoryLimitMib: number;
}

export interface ExportManifestAppDetails {
  name: string | null;
  description: string | null;
}

export interface ExportManifestSchedule {
  name: string;
  cronPattern: string;
  timeZone: string;
  targetPath: string;
  method: string;
  body: JsonValue;
  headers: Record<string, string> | null;
}

export interface ExportManifestAgent {
  slug: string;
  displayName: string | null;
  origin: string;
  package: string;
}

/** Older archives carry no `kind`; a manifest without one is a Project export. */
export const PROJECT_EXPORT_KIND = 'project';

export interface ExportManifest {
  kind?: typeof PROJECT_EXPORT_KIND;
  title: string | null;
  description: string | null;
  /** @deprecated superseded by `agent`; still written and read so older archives keep importing. */
  agentName: string | null;
  agent: ExportManifestAgent | null;
  settings: ExportManifestSettings;
  resources: ExportManifestResources;
  appDetails: ExportManifestAppDetails | null;
  schedules: ExportManifestSchedule[];
  stamp: ExportManifestStamp;
}
