import { createContext, useContext } from 'solid-js';
import type { PublishJob } from '~/api/publish';
import type { DuplicateJob } from '~/api/duplicate';
import type { ExportJob } from '~/api/export';
import type { ImportJob, ImportUploadFailure } from '~/api/import';

export type { ImportUploadFailure } from '~/api/import';

export type JobKind = 'publish' | 'duplicate' | 'export' | 'import';

interface TrackedBase {
  key: string;
  kind: JobKind;
  id: string;
  title: string;
  lastStep: string;
}

export interface TrackedPublish extends TrackedBase {
  kind: 'publish';
  projectId: string;
  job: PublishJob | null;
}

export interface TrackedDuplicate extends TrackedBase {
  kind: 'duplicate';
  projectId: string;
  job: DuplicateJob | null;
}

export interface TrackedExport extends TrackedBase {
  kind: 'export';
  projectId: string;
  job: ExportJob;
}

export type ImportUploadPhase = 'uploading' | 'finalizing' | 'enqueued';

export interface ImportUploadState {
  uploadId: string;
  size: number;
  bytesSent: number;
  phase: ImportUploadPhase;
  failure: ImportUploadFailure | null;
}

export interface TrackedImport extends TrackedBase {
  kind: 'import';
  projectId: string | null;
  job: ImportJob | null;
  upload: ImportUploadState;
}

export type TrackedJob = TrackedPublish | TrackedDuplicate | TrackedExport | TrackedImport;

export interface ProjectViewHandlers {
  onPublishDone?: (job: PublishJob) => void;
  viewEnvironment?: (projectEnvironmentId: string) => void;
}

export interface StartImportUploadInput {
  file: File;
  uploadId: string;
  chunkSize: number;
  title: string;
  workspaceId: string | null;
  folderId: string | null;
}

export interface JobDockApi {
  trackPublish: (input: { projectId: string; environmentId: string; environmentName: string }) => void;
  trackDuplicate: (input: { projectId: string; title: string }) => void;
  trackExport: (input: { projectId: string; title: string; job: ExportJob }) => void;
  startImportUpload: (input: StartImportUploadInput) => void;
  entries: () => TrackedJob[];
  registerProjectView: (projectId: string, handlers: ProjectViewHandlers) => () => void;
}

export const JobDockContext = createContext<JobDockApi>();

export function useJobDock(): JobDockApi {
  const ctx = useContext(JobDockContext);
  if (!ctx) throw new Error('useJobDock must be used within JobDockHost');
  return ctx;
}
