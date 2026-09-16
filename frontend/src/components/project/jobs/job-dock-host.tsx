import { For, Show, createEffect, createSignal, onCleanup, type ParentProps } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import { useNavigate } from '@tanstack/solid-router';
import { useQueryClient } from '@tanstack/solid-query';
import type { StartImportResult } from '~/api/import';
import {
  JobDockContext,
  type ImportUploadState,
  type JobDockApi,
  type ProjectViewHandlers,
  type TrackedJob,
} from './job-dock-context';
import { framePhase, jobGuardsUnload, jobOnTerminal, jobSseUrl, parseJobFrame, type JobHost } from './job-kind';
import { createImportUploadRunner } from './import-upload-runner';
import { JobCard } from './job-card';
import { JobDialog } from './job-dialog';

function warnOnUnload(event: BeforeUnloadEvent) {
  event.preventDefault();
}

function initialLastStep(status: string): string {
  return status === 'failed' ? 'queued' : status;
}

export function JobDockHost(props: ParentProps) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [tracked, setTracked] = createStore<Record<string, TrackedJob>>({});
  const [expandedKey, setExpandedKey] = createSignal<string | null>(null);
  const sources = new Map<string, EventSource>();
  const projectViews = new Map<string, ProjectViewHandlers>();

  const closeStream = (key: string) => {
    sources.get(key)?.close();
    sources.delete(key);
  };

  const patchUpload = (key: string, patch: Partial<ImportUploadState>) => {
    setTracked(
      produce((draft) => {
        const entry = draft[key];
        if (entry?.kind === 'import') Object.assign(entry.upload, patch);
      })
    );
  };

  const adoptImportJob = (key: string, result: StartImportResult) => {
    setTracked(
      produce((draft) => {
        const entry = draft[key];
        if (entry?.kind !== 'import') return;
        entry.projectId = result.projectId;
        entry.job = result.job;
        entry.lastStep = initialLastStep(result.job.status);
        entry.upload.phase = 'enqueued';
        entry.upload.bytesSent = entry.upload.size;
      })
    );
    openStream(key);
  };

  const uploads = createImportUploadRunner({ patchUpload, onEnqueued: adoptImportJob });

  const dismiss = (key: string) => {
    uploads.cancel(key);
    closeStream(key);
    if (expandedKey() === key) setExpandedKey(null);
    setTracked(
      produce((draft) => {
        delete draft[key];
      })
    );
  };

  const host: JobHost = {
    qc,
    navigate: (projectId) =>
      navigate({
        to: '/projects/$projectId',
        params: { projectId },
        search: { prompt: undefined, promptId: undefined },
      }),
    dismiss,
    retry: (key) => uploads.retry(key),
    projectView: (projectId) => projectViews.get(projectId),
  };

  const openStream = (key: string) => {
    const entry = tracked[key];
    if (!entry || sources.has(key)) return;
    const url = jobSseUrl(entry);
    if (!url) return;
    const source = new EventSource(url);
    source.addEventListener('message', (event) => {
      try {
        const current = tracked[key];
        if (!current) return;
        const job = parseJobFrame(event.data);
        setTracked(key, 'job', job);
        const phase = framePhase(current.kind, job);
        if (phase === 'running') {
          setTracked(key, 'lastStep', job.status);
        } else {
          closeStream(key);
          jobOnTerminal(tracked[key], host);
        }
      } catch {
        // ignore malformed frames
      }
    });
    sources.set(key, source);
  };

  const track = (key: string, entry: TrackedJob) => {
    setTracked(key, entry);
    setExpandedKey(key);
    openStream(key);
  };

  const api: JobDockApi = {
    trackPublish: (input) => {
      const key = `publish:${input.environmentId}`;
      track(key, {
        kind: 'publish',
        key,
        id: input.environmentId,
        projectId: input.projectId,
        title: input.environmentName,
        environmentSlug: input.environmentSlug,
        job: null,
        lastStep: 'queued',
      });
    },
    trackDuplicate: (input) => {
      const key = `duplicate:${input.projectId}`;
      track(key, {
        kind: 'duplicate',
        key,
        id: input.projectId,
        projectId: input.projectId,
        title: input.title,
        job: null,
        lastStep: 'queued',
      });
    },
    trackExport: (input) => {
      const key = `export:${input.projectId}`;
      track(key, {
        kind: 'export',
        key,
        id: input.projectId,
        projectId: input.projectId,
        title: input.title,
        job: input.job,
        lastStep: initialLastStep(input.job.status),
      });
    },
    startImportUpload: (input) => {
      const key = `import:${input.uploadId}`;
      setTracked(key, {
        kind: 'import',
        key,
        id: input.uploadId,
        projectId: null,
        title: input.title.trim() || input.file.name,
        job: null,
        lastStep: 'uploading',
        upload: {
          uploadId: input.uploadId,
          size: input.file.size,
          bytesSent: 0,
          phase: 'uploading',
          failure: null,
        },
      });
      uploads.start(key, input);
    },
    entries: () => Object.values(tracked),
    registerProjectView: (projectId, handlers) => {
      projectViews.set(projectId, handlers);
      return () => {
        if (projectViews.get(projectId) === handlers) projectViews.delete(projectId);
      };
    },
  };

  onCleanup(() => {
    sources.forEach((source) => source.close());
    sources.clear();
  });

  const entries = () => Object.values(tracked);

  createEffect(() => {
    if (!entries().some(jobGuardsUnload)) return;
    window.addEventListener('beforeunload', warnOnUnload);
    onCleanup(() => window.removeEventListener('beforeunload', warnOnUnload));
  });

  const expandedEntry = () => {
    const key = expandedKey();
    return key ? tracked[key] : undefined;
  };

  return (
    <JobDockContext.Provider value={api}>
      {props.children}

      <Show when={entries().length > 0}>
        <div class="pointer-events-none fixed bottom-4 right-4 z-40 flex flex-col items-end gap-2">
          <For each={entries()}>
            {(entry) => (
              <Show when={expandedKey() !== entry.key}>
                <JobCard
                  entry={entry}
                  host={host}
                  onExpand={() => setExpandedKey(entry.key)}
                  onDismiss={() => dismiss(entry.key)}
                />
              </Show>
            )}
          </For>
        </div>
      </Show>

      <Show when={expandedEntry()}>
        {(entry) => (
          <JobDialog
            entry={entry()}
            host={host}
            onMinimize={() => setExpandedKey(null)}
            onDismiss={() => dismiss(entry().key)}
          />
        )}
      </Show>
    </JobDockContext.Provider>
  );
}
