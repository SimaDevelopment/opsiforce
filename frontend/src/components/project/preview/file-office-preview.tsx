import { Match, Switch, createEffect, createSignal, on, onCleanup } from 'solid-js';
import { ApiError } from '~/api/client';
import { fileConversionResultUrl, readFileConversion, startFileConversion, type ConversionFailure } from '~/api/files';
import { FileDownloadCard } from './file-download-card';
import { FilePreviewNotice } from './file-preview-notice';
import { FileRenderedPreview } from './file-rendered-preview';

const POLL_INTERVAL_MS = 1000;
const CONVERSION_TIMEOUT_MS = 120_000;

type ConversionState =
  | { status: 'converting' }
  | { status: 'ready'; jobId: string }
  | { status: 'missing' }
  | { status: 'failed'; failure: ConversionFailure; message?: string };

export interface FileOfficePreviewProps {
  projectId: string;
  environmentId: string;
  path: string;
  name: string;
  onDownload: () => void;
}

export function FileOfficePreview(props: FileOfficePreviewProps) {
  const [attempt, setAttempt] = createSignal(0);
  const [state, setState] = createSignal<ConversionState>({ status: 'converting' });

  createEffect(
    on([() => props.projectId, () => props.environmentId, () => props.path, attempt], () => {
      let cancelled = false;
      onCleanup(() => {
        cancelled = true;
      });
      setState({ status: 'converting' });
      void convert(
        { projectId: props.projectId, environmentId: props.environmentId, path: props.path },
        () => cancelled,
        setState
      );
    })
  );

  const retryable = () => {
    const current = state();
    return current.status === 'failed' && current.failure !== 'unconvertible';
  };

  return (
    <Switch>
      <Match when={state().status === 'converting'}>
        <FilePreviewNotice title="Converting to PDF…" detail="Large documents can take a moment." loading />
      </Match>
      <Match when={state().status === 'missing'}>
        <FilePreviewNotice title="File not found" detail="It may have been renamed, moved, or deleted." />
      </Match>
      <Match when={state().status === 'failed'}>
        <FileDownloadCard
          name={props.name}
          detail={failureDetail(state())}
          onDownload={props.onDownload}
          onRetry={retryable() ? () => setAttempt(attempt() + 1) : undefined}
        />
      </Match>
      <Match when={readyJobId(state())}>
        {(jobId) => (
          <FileRenderedPreview
            url={fileConversionResultUrl(props.projectId, props.environmentId, jobId())}
            name={props.name}
            pdf
          />
        )}
      </Match>
    </Switch>
  );
}

async function convert(
  target: { projectId: string; environmentId: string; path: string },
  cancelled: () => boolean,
  setState: (state: ConversionState) => void
): Promise<void> {
  let jobId: string;
  try {
    ({ jobId } = await startFileConversion(target.projectId, target.environmentId, target.path));
  } catch (err) {
    if (cancelled()) return;
    if (err instanceof ApiError && err.status === 404) {
      setState({ status: 'missing' });
      return;
    }
    if (err instanceof ApiError && err.status === 429) {
      setState({ status: 'failed', failure: 'busy', message: 'The converter is busy. Try again in a moment.' });
      return;
    }
    setState({ status: 'failed', failure: 'retryable' });
    return;
  }

  const deadline = Date.now() + CONVERSION_TIMEOUT_MS;
  while (!cancelled()) {
    let progress;
    try {
      progress = await readFileConversion(target.projectId, target.environmentId, jobId);
    } catch {
      if (!cancelled()) setState({ status: 'failed', failure: 'retryable' });
      return;
    }
    if (cancelled()) return;

    if (progress.status === 'complete') {
      setState({ status: 'ready', jobId });
      return;
    }
    if (progress.status === 'failed') {
      setState({ status: 'failed', failure: progress.failure ?? 'retryable', message: progress.error });
      return;
    }
    if (Date.now() >= deadline) {
      setState({ status: 'failed', failure: 'busy', message: 'Converting is taking longer than expected.' });
      return;
    }
    await delay(POLL_INTERVAL_MS);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readyJobId(state: ConversionState): string | null {
  return state.status === 'ready' ? state.jobId : null;
}

function failureDetail(state: ConversionState): string {
  if (state.status !== 'failed') return '';
  if (state.failure === 'unconvertible') return state.message ?? 'This document could not be converted for preview.';
  return state.message ?? 'The converter is unavailable right now.';
}
