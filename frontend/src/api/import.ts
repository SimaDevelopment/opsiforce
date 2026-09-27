import { api, ApiError, currentTenant, parseErrorMessage, TENANT_HEADER } from './client';
import { detectTimezone } from '~/lib/timezone';

export type ImportJobStatus = 'queued' | 'unpacking' | 'starting' | 'completed' | 'failed';

export interface ImportJob {
  id: string;
  projectId: string;
  status: ImportJobStatus;
  bytesTotal: number;
  bytesProcessed: number;
  agentFallbackFrom: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StartImportResult {
  projectId: string;
  job: ImportJob;
}

export interface ImportUploadSession {
  uploadId: string;
  chunkSize: number;
}

export function createImportUploadSession(size: number): Promise<ImportUploadSession> {
  return api.post<ImportUploadSession>('/projects/import/uploads', { size });
}

export interface FinalizeImportParams {
  uploadId: string;
  workspaceId: string | null;
  folderId: string | null;
  title: string;
}

export function finalizeProjectImport(params: FinalizeImportParams): Promise<StartImportResult> {
  return api.post<StartImportResult>('/projects/import', {
    uploadId: params.uploadId,
    workspaceId: params.workspaceId,
    folderId: params.folderId,
    title: params.title.trim() || null,
    timezone: detectTimezone(),
  });
}

export function cancelImportUploadSession(uploadId: string): void {
  void api.delete<void>(`/projects/import/uploads/${uploadId}`).catch(() => {});
}

export type ImportFailureKind = 'upload' | 'finalize-rejected' | 'finalize-transient';

export interface ImportUploadFailure {
  kind: ImportFailureKind;
  message: string;
  resumable: boolean;
}

export class ImportUploadError extends Error implements ImportUploadFailure {
  constructor(
    readonly kind: ImportFailureKind,
    message: string,
    readonly resumable: boolean
  ) {
    super(message);
  }

  toFailure(): ImportUploadFailure {
    return { kind: this.kind, message: this.message, resumable: this.resumable };
  }
}

const CHUNK_BACKOFF_MS = [1000, 3000, 5000, 10000, 15000, 20000];
const MAX_CHUNK_ATTEMPTS = CHUNK_BACKOFF_MS.length + 1;

export interface ImportChunksRun {
  file: File;
  uploadId: string;
  chunkSize: number;
  startIndex: number;
  signal: AbortSignal;
  onProgress: (bytesSent: number) => void;
  onChunkConfirmed: (nextIndex: number) => void;
}

export interface ImportUploadRun extends FinalizeImportParams, ImportChunksRun {
  onFinalizing: () => void;
}

export async function runImportUpload(run: ImportUploadRun): Promise<StartImportResult> {
  await uploadImportChunks(run);

  run.onFinalizing();
  try {
    return await finalizeProjectImport({
      uploadId: run.uploadId,
      workspaceId: run.workspaceId,
      folderId: run.folderId,
      title: run.title,
    });
  } catch (err) {
    throw finalizeFailure(
      err instanceof ApiError ? err : new ApiError(0, err instanceof Error ? err.message : 'The import failed.')
    );
  }
}

export async function uploadImportChunks(run: ImportChunksRun): Promise<void> {
  const total = run.file.size;
  const chunkCount = Math.ceil(total / run.chunkSize);
  let sentBytes = Math.min(run.startIndex * run.chunkSize, total);
  run.onProgress(sentBytes);

  for (let index = run.startIndex; index < chunkCount; index += 1) {
    const start = index * run.chunkSize;
    const chunk = run.file.slice(start, Math.min(start + run.chunkSize, total));
    const base = sentBytes;
    await sendImportChunk({
      uploadId: run.uploadId,
      index,
      chunk,
      digest: await sha256Hex(chunk),
      signal: run.signal,
      onProgress: (loaded) => run.onProgress(Math.min(base + loaded, total)),
    });
    sentBytes = base + chunk.size;
    run.onProgress(sentBytes);
    run.onChunkConfirmed(index + 1);
  }
}

interface PutImportChunkParams {
  uploadId: string;
  index: number;
  chunk: Blob;
  digest: string;
  signal: AbortSignal;
  onProgress: (loaded: number) => void;
}

async function sendImportChunk(params: PutImportChunkParams): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await putImportChunk(params);
      return;
    } catch (err) {
      if (params.signal.aborted) throw cancelled();
      const failure = err instanceof ApiError ? err : new ApiError(0, 'The connection dropped during upload.');
      const delay = chunkRetryDelay(failure.status, attempt);
      if (delay === null) throw chunkRejection(failure);
      if (attempt >= MAX_CHUNK_ATTEMPTS) throw new ImportUploadError('upload', 'Check your connection.', true);
      await sleep(delay, params.signal);
    }
  }
}

function chunkRetryDelay(status: number, attempt: number): number | null {
  if (status === 504 || status === 422) return 0;
  if (status === 0 || status >= 500) return CHUNK_BACKOFF_MS[Math.min(attempt - 1, CHUNK_BACKOFF_MS.length - 1)];
  return null;
}

function chunkRejection(err: ApiError): ImportUploadError {
  const message =
    err.status === 404 ? 'The upload session is no longer available. Start the import again.' : err.message;
  return new ImportUploadError('upload', message, false);
}

function finalizeFailure(err: ApiError): ImportUploadError {
  if (err.status === 404) {
    return new ImportUploadError(
      'finalize-rejected',
      'The upload session is no longer available. It may already have been imported — check your projects before starting over.',
      false
    );
  }
  const rejected = err.status === 400;
  return new ImportUploadError(rejected ? 'finalize-rejected' : 'finalize-transient', err.message, !rejected);
}

function cancelled(): ImportUploadError {
  return new ImportUploadError('upload', 'The upload was cancelled.', false);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelled());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function putImportChunk(params: PutImportChunkParams): Promise<void> {
  return new Promise((resolve, reject) => {
    if (params.signal.aborted) {
      reject(cancelled());
      return;
    }
    const xhr = new XMLHttpRequest();
    const onAbort = () => xhr.abort();
    params.signal.addEventListener('abort', onAbort, { once: true });
    xhr.addEventListener('loadend', () => params.signal.removeEventListener('abort', onAbort));
    xhr.open('PUT', `/api/projects/import/uploads/${params.uploadId}/chunks/${params.index}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-Chunk-Sha256', params.digest);
    const tenant = currentTenant();
    if (tenant) xhr.setRequestHeader(TENANT_HEADER, tenant);

    xhr.upload.addEventListener('progress', (event) => params.onProgress(event.loaded));
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new ApiError(xhr.status, parseErrorMessage(xhr.responseText, `Chunk upload failed (${xhr.status})`)));
    });
    xhr.addEventListener('error', () => reject(new ApiError(0, 'The connection dropped during upload.')));
    xhr.addEventListener('timeout', () => reject(new ApiError(0, 'The upload timed out.')));
    xhr.addEventListener('abort', () => reject(new ApiError(0, 'The upload was cancelled.')));
    xhr.send(params.chunk);
  });
}

async function sha256Hex(chunk: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await chunk.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function importEventsUrl(projectId: string): string {
  const params = new URLSearchParams();
  const tenant = currentTenant();
  if (tenant) params.set('tenant', tenant);
  const query = params.toString();
  return `/api/projects/${projectId}/import/job/stream${query ? `?${query}` : ''}`;
}
