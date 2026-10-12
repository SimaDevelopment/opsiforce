import type { Component } from 'solid-js';
import type { QueryClient } from '@tanstack/solid-query';
import { Copy, Download, ExternalLink, Layers, Package, Rocket, RotateCcw } from '~/components/icons';
import { appPublicUrl } from '~/lib/app-url';
import { environmentKeys } from '~/api/environments';
import {
  publishEventsUrl,
  publishKeys,
  type PublishJob,
  type PublishJobStatus,
  type PublishReportLine,
} from '~/api/publish';
import { duplicateEventsUrl, type DuplicateJob, type DuplicateJobStatus } from '~/api/duplicate';
import { exportEventsUrl, triggerExportDownload, type ExportJob, type ExportJobStatus } from '~/api/export';
import { importEventsUrl, type ImportJob } from '~/api/import';
import type { ProgressStep } from '~/components/project/step-progress';
import { PUBLISH_STEPS, publishStepIndex } from '~/components/project/environments/publish-steps';
import { DUPLICATE_STEPS, duplicateStepIndex } from '~/components/project/duplicate-steps';
import { EXPORT_STEPS, exportStepIndex } from '~/components/project/export-steps';
import { IMPORT_STEPS, importStepIndex, type ImportPhase } from '~/components/project/import-steps';
import type {
  ImportUploadFailure,
  JobKind,
  TrackedDuplicate,
  TrackedExport,
  TrackedImport,
  TrackedJob,
  TrackedPublish,
} from './job-dock-context';

type AnyJob = PublishJob | DuplicateJob | ExportJob | ImportJob;
type IconComponent = Component<{ class?: string }>;

export type JobPhase = 'running' | 'done' | 'failed';

export interface JobActionDescriptor {
  label: string;
  icon: IconComponent;
  variant: 'primary' | 'outline';
  href?: string;
  onSelect?: () => void;
}

export interface JobHost {
  qc: QueryClient;
  navigate: (projectId: string) => void;
  dismiss: (key: string) => void;
  retry: (key: string) => void;
  projectView: (
    projectId: string
  ) => { onPublishDone?: (job: PublishJob) => void; viewEnvironment?: (id: string) => void } | undefined;
}

export interface JobDisplay {
  phase: JobPhase;
  headerIcon: IconComponent;
  cardTitle: string;
  dialogTitle: string;
  dialogNote: string;
  steps: ProgressStep[];
  currentIndex: number;
  totalSteps: number;
  stepLabel: string;
  progressPercent: number;
  error: string | null;
  notice: string | null;
  report?: string[];
  accentPulse: boolean;
  dismissLabel?: string;
  dismissWhileRunning?: boolean;
}

export interface JobKindAdapter<E extends TrackedJob> {
  describe: (entry: E) => JobDisplay;
  actions: (entry: E, host: JobHost) => JobActionDescriptor[];
  sseUrl: (entry: E) => string | null;
  onTerminal: (entry: E, host: JobHost) => void;
  guardsUnload?: (entry: E) => boolean;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index++;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function withByteDetail(
  source: { key: string; label: string; detail: string }[],
  byteKey: string,
  bytesProcessed: number,
  bytesTotal: number
): ProgressStep[] {
  return source.map((step) =>
    step.key === byteKey && bytesTotal > 0
      ? { label: step.label, detail: `${formatBytes(bytesProcessed)} of ${formatBytes(bytesTotal)}` }
      : { label: step.label, detail: step.detail }
  );
}

function runningStepLabel(steps: { label: string }[], index: number): string {
  return `${steps[index]?.label ?? 'Working'} · step ${index + 1} of ${steps.length}`;
}

function publishReportText(line: PublishReportLine, environmentName: string): string {
  if (line.kind === 'skills-off') {
    const changes = [
      line.switchedOff.length > 0 ? `switched off ${line.switchedOff.join(', ')}` : '',
      line.switchedOn.length > 0 ? `switched back on ${line.switchedOn.join(', ')}` : '',
    ].filter(Boolean);
    return `Skills in ${environmentName} now match Development: ${changes.join('; ')}.`;
  }
  if (line.outcome === 'failed') {
    return `${line.displayName}: its configuration couldn't be copied to ${environmentName} (${line.code}); Development keeps receiving.`;
  }
  const copied = `${line.displayName}: configuration copied to ${environmentName}`;
  if (line.receiveTurnedOff.length === 0) return `${copied}.`;
  return `${copied}; Receive turned off in Development for ${line.receiveTurnedOff.join(', ')}.`;
}

const publishAdapter: JobKindAdapter<TrackedPublish> = {
  describe(entry) {
    const job = entry.job;
    const phase: JobPhase = !job
      ? 'running'
      : job.status === 'done'
        ? 'done'
        : job.status === 'failed'
          ? 'failed'
          : 'running';
    const runningIndex = job ? publishStepIndex(job.status) : 0;
    return {
      phase,
      headerIcon: Rocket,
      cardTitle:
        phase === 'done'
          ? `${entry.title} is live`
          : phase === 'failed'
            ? `Publish to ${entry.title} failed`
            : `Publishing to ${entry.title}`,
      dialogTitle:
        phase === 'done'
          ? `${entry.title} is live`
          : phase === 'failed'
            ? `Publish to ${entry.title} failed`
            : `Publishing to ${entry.title}`,
      dialogNote: 'Closing this keeps the publish running; a progress card stays in the corner.',
      steps: PUBLISH_STEPS.map((step) => ({ label: step.label, detail: step.detail })),
      currentIndex: phase === 'failed' ? publishStepIndex(entry.lastStep as PublishJobStatus) : runningIndex,
      totalSteps: PUBLISH_STEPS.length,
      stepLabel: job ? runningStepLabel(PUBLISH_STEPS, runningIndex) : 'Starting',
      progressPercent: ((runningIndex + 1) / PUBLISH_STEPS.length) * 100,
      error: job?.error ?? null,
      notice: null,
      report: (job?.report ?? []).map((line) => publishReportText(line, entry.title)),
      accentPulse: true,
    };
  },
  actions(entry, host) {
    const job = entry.job;
    if (!job || job.status !== 'done') return [];
    return [
      {
        label: 'Open app',
        icon: ExternalLink,
        variant: 'outline',
        href: appPublicUrl(job.projectEnvironmentId, entry.environmentSlug),
      },
      {
        label: 'View environment',
        icon: Layers,
        variant: 'outline',
        onSelect: () => {
          const view = host.projectView(entry.projectId);
          if (view?.viewEnvironment) view.viewEnvironment(job.projectEnvironmentId);
          else host.navigate(entry.projectId);
          host.dismiss(entry.key);
        },
      },
    ];
  },
  sseUrl: (entry) => publishEventsUrl(entry.projectId, entry.id),
  onTerminal(entry, host) {
    host.qc.invalidateQueries({ queryKey: environmentKeys.forProject(entry.projectId) });
    host.qc.invalidateQueries({ queryKey: publishKeys.targets(entry.projectId) });
    if (entry.job?.status === 'done') host.projectView(entry.projectId)?.onPublishDone?.(entry.job);
  },
};

const duplicateAdapter: JobKindAdapter<TrackedDuplicate> = {
  describe(entry) {
    const job = entry.job;
    const phase: JobPhase = !job
      ? 'running'
      : job.status === 'completed'
        ? 'done'
        : job.status === 'failed'
          ? 'failed'
          : 'running';
    const runningIndex = job ? duplicateStepIndex(job.status) : 0;
    return {
      phase,
      headerIcon: Copy,
      cardTitle:
        phase === 'done'
          ? `${entry.title} copied`
          : phase === 'failed'
            ? 'Duplicate failed'
            : `Duplicating ${entry.title}`,
      dialogTitle:
        phase === 'done'
          ? `${entry.title} copied`
          : phase === 'failed'
            ? 'Duplicate failed'
            : `Duplicating ${entry.title}`,
      dialogNote: 'Closing this keeps the duplicate running; a progress card stays in the corner.',
      steps: withByteDetail(DUPLICATE_STEPS, 'copying', job?.bytesProcessed ?? 0, job?.bytesTotal ?? 0),
      currentIndex: phase === 'failed' ? duplicateStepIndex(entry.lastStep as DuplicateJobStatus) : runningIndex,
      totalSteps: DUPLICATE_STEPS.length,
      stepLabel: job ? runningStepLabel(DUPLICATE_STEPS, runningIndex) : 'Starting',
      progressPercent: ((runningIndex + 1) / DUPLICATE_STEPS.length) * 100,
      error: job?.error ?? null,
      notice: null,
      accentPulse: false,
    };
  },
  actions(entry, host) {
    if (entry.job?.status !== 'completed') return [];
    return [
      {
        label: 'Open project',
        icon: ExternalLink,
        variant: 'primary',
        onSelect: () => {
          host.navigate(entry.projectId);
          host.dismiss(entry.key);
        },
      },
    ];
  },
  sseUrl: (entry) => duplicateEventsUrl(entry.projectId),
  onTerminal(entry, host) {
    if (entry.job?.status === 'completed') host.qc.invalidateQueries({ queryKey: ['projects'] });
  },
};

const exportAdapter: JobKindAdapter<TrackedExport> = {
  describe(entry) {
    const job = entry.job;
    const phase: JobPhase = job.status === 'completed' ? 'done' : job.status === 'failed' ? 'failed' : 'running';
    const runningIndex = exportStepIndex(job.status);
    return {
      phase,
      headerIcon: Package,
      cardTitle: phase === 'done' ? 'Export ready' : phase === 'failed' ? 'Export failed' : `Exporting ${entry.title}`,
      dialogTitle:
        phase === 'done' ? 'Export ready' : phase === 'failed' ? 'Export failed' : `Exporting ${entry.title}`,
      dialogNote:
        'The export file contains live environment variable values and the full conversation — treat it as sensitive. Closing this keeps the export running; a progress card stays in the corner.',
      steps: withByteDetail(EXPORT_STEPS, 'archiving', job.bytesProcessed, job.bytesTotal),
      currentIndex: phase === 'failed' ? exportStepIndex(entry.lastStep as ExportJobStatus) : runningIndex,
      totalSteps: EXPORT_STEPS.length,
      stepLabel: runningStepLabel(EXPORT_STEPS, runningIndex),
      progressPercent: ((runningIndex + 1) / EXPORT_STEPS.length) * 100,
      error: job.error,
      notice: null,
      accentPulse: false,
    };
  },
  actions(entry, host) {
    const job = entry.job;
    if (job.status !== 'completed') return [];
    return [
      {
        label: 'Download',
        icon: Download,
        variant: 'primary',
        onSelect: () => {
          triggerExportDownload(entry.projectId, job.id, job.fileName ?? undefined);
          host.dismiss(entry.key);
        },
      },
    ];
  },
  sseUrl: (entry) => exportEventsUrl(entry.projectId),
  onTerminal() {},
};

function importSteps(entry: TrackedImport): ProgressStep[] {
  const job = entry.job;
  const upload = entry.upload;
  return IMPORT_STEPS.map((step) => {
    if (step.key === 'uploading') {
      return {
        label: step.label,
        detail:
          upload.phase === 'uploading'
            ? `${formatBytes(upload.bytesSent)} of ${formatBytes(upload.size)}`
            : 'Assembling the export file',
      };
    }
    if (step.key === 'unpacking' && job && job.bytesTotal > 0) {
      return { label: step.label, detail: `${formatBytes(job.bytesProcessed)} of ${formatBytes(job.bytesTotal)}` };
    }
    return { label: step.label, detail: step.detail };
  });
}

function importFailureTitle(failure: ImportUploadFailure): string {
  return failure.kind === 'upload' ? 'Upload interrupted' : 'Import failed';
}

function importFailureMessage(failure: ImportUploadFailure): string {
  return failure.kind === 'finalize-transient' ? `${failure.message} Your upload is safe.` : failure.message;
}

function importDismissLabel(entry: TrackedImport): string | undefined {
  const failure = entry.upload.failure;
  if (failure) return failure.kind === 'upload' ? 'Cancel' : 'Dismiss';
  return entry.upload.phase === 'enqueued' ? undefined : 'Cancel upload';
}

const importAdapter: JobKindAdapter<TrackedImport> = {
  describe(entry) {
    const job = entry.job;
    const upload = entry.upload;
    const failure = upload.failure;
    const phase: JobPhase = failure
      ? 'failed'
      : !job
        ? 'running'
        : job.status === 'completed'
          ? 'done'
          : job.status === 'failed'
            ? 'failed'
            : 'running';
    const runningIndex = job ? importStepIndex(job.status) : importStepIndex('uploading');
    const stepShare = 100 / IMPORT_STEPS.length;
    const uploadFraction = upload.size > 0 ? Math.min(upload.bytesSent / upload.size, 1) : 0;
    const transferring = !job && upload.phase === 'uploading';
    const title =
      phase === 'done'
        ? `${entry.title} imported`
        : phase === 'failed'
          ? failure
            ? importFailureTitle(failure)
            : 'Import failed'
          : `Importing ${entry.title}`;
    return {
      phase,
      headerIcon: Package,
      cardTitle: title,
      dialogTitle: title,
      dialogNote: job
        ? 'Closing this keeps the import running; a progress card stays in the corner.'
        : 'Closing this keeps the upload running; a progress card stays in the corner. Reloading or closing the tab cancels it.',
      steps: importSteps(entry),
      currentIndex: phase === 'failed' ? importStepIndex(entry.lastStep as ImportPhase) : runningIndex,
      totalSteps: IMPORT_STEPS.length,
      stepLabel: transferring
        ? `Uploading ${formatBytes(upload.bytesSent)} of ${formatBytes(upload.size)} · step 1 of ${IMPORT_STEPS.length}`
        : runningStepLabel(IMPORT_STEPS, runningIndex),
      progressPercent: transferring ? uploadFraction * stepShare : ((runningIndex + 1) / IMPORT_STEPS.length) * 100,
      error: failure ? importFailureMessage(failure) : (job?.error ?? null),
      notice: job?.agentFallbackFrom
        ? `The export's agent "${job.agentFallbackFrom}" isn't available here, so the default agent was used instead.`
        : null,
      accentPulse: false,
      dismissLabel: importDismissLabel(entry),
      dismissWhileRunning: !failure && upload.phase === 'uploading',
    };
  },
  actions(entry, host) {
    const failure = entry.upload.failure;
    if (failure) {
      if (!failure.resumable) return [];
      return [{ label: 'Retry', icon: RotateCcw, variant: 'primary', onSelect: () => host.retry(entry.key) }];
    }
    const projectId = entry.projectId;
    if (!projectId || entry.job?.status !== 'completed') return [];
    return [
      {
        label: 'Open project',
        icon: ExternalLink,
        variant: 'primary',
        onSelect: () => {
          host.navigate(projectId);
          host.dismiss(entry.key);
        },
      },
    ];
  },
  sseUrl: (entry) => (entry.projectId ? importEventsUrl(entry.projectId) : null),
  onTerminal(entry, host) {
    if (entry.job?.status === 'completed') host.qc.invalidateQueries({ queryKey: ['projects'] });
  },
  guardsUnload: (entry) => entry.upload.phase !== 'enqueued' && (entry.upload.failure?.resumable ?? true),
};

export function describeJob(entry: TrackedJob): JobDisplay {
  switch (entry.kind) {
    case 'publish':
      return publishAdapter.describe(entry);
    case 'duplicate':
      return duplicateAdapter.describe(entry);
    case 'export':
      return exportAdapter.describe(entry);
    case 'import':
      return importAdapter.describe(entry);
  }
}

export function jobActions(entry: TrackedJob, host: JobHost): JobActionDescriptor[] {
  switch (entry.kind) {
    case 'publish':
      return publishAdapter.actions(entry, host);
    case 'duplicate':
      return duplicateAdapter.actions(entry, host);
    case 'export':
      return exportAdapter.actions(entry, host);
    case 'import':
      return importAdapter.actions(entry, host);
  }
}

export function jobSseUrl(entry: TrackedJob): string | null {
  switch (entry.kind) {
    case 'publish':
      return publishAdapter.sseUrl(entry);
    case 'duplicate':
      return duplicateAdapter.sseUrl(entry);
    case 'export':
      return exportAdapter.sseUrl(entry);
    case 'import':
      return importAdapter.sseUrl(entry);
  }
}

export function jobGuardsUnload(entry: TrackedJob): boolean {
  switch (entry.kind) {
    case 'publish':
      return publishAdapter.guardsUnload?.(entry) ?? false;
    case 'duplicate':
      return duplicateAdapter.guardsUnload?.(entry) ?? false;
    case 'export':
      return exportAdapter.guardsUnload?.(entry) ?? false;
    case 'import':
      return importAdapter.guardsUnload?.(entry) ?? false;
  }
}

export function jobOnTerminal(entry: TrackedJob, host: JobHost): void {
  switch (entry.kind) {
    case 'publish':
      return publishAdapter.onTerminal(entry, host);
    case 'duplicate':
      return duplicateAdapter.onTerminal(entry, host);
    case 'export':
      return exportAdapter.onTerminal(entry, host);
    case 'import':
      return importAdapter.onTerminal(entry, host);
  }
}

export function parseJobFrame(raw: string): AnyJob {
  return JSON.parse(raw) as AnyJob;
}

export function framePhase(kind: JobKind, job: AnyJob): JobPhase {
  if (kind === 'publish') {
    return job.status === 'done' ? 'done' : job.status === 'failed' ? 'failed' : 'running';
  }
  return job.status === 'completed' ? 'done' : job.status === 'failed' ? 'failed' : 'running';
}
