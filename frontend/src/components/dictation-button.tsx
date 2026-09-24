import { createEffect, createSignal, onCleanup, onMount, Show, Switch, Match } from 'solid-js';
import { Portal } from 'solid-js/web';
import { toast } from 'solid-sonner';
import { Tooltip, TooltipTrigger, TooltipContent } from '~/components/ui/tooltip';
import { LoaderCircle, Mic, X } from '~/components/icons';
import { useNow } from '~/lib/use-now';
import { cn } from '~/lib/cn';
import { extractErrorMessage } from '~/api/client';
import { useTranscriptionAvailability } from '~/api/transcription';
import { dictationLanguage, reconcileDictationLanguage, DictationLanguageMenu } from '~/components/dictation-language';

const PROMPT_EDITOR_SELECTOR = '[data-component="composer-editor"]';
const PROMPT_SUBMIT_SELECTOR = '[data-action="composer-submit"]';
const TOOLBAR_GRACE_MS = 2000;
const MAX_RECORDING_MS = 5 * 60 * 1000;
const AUDIO_BITS_PER_SECOND = 32_000;
const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];

type DictationState = 'idle' | 'recording' | 'transcribing';

interface ActiveRecording {
  recorder: MediaRecorder;
  stream: MediaStream;
  chunks: Blob[];
  capTimer: ReturnType<typeof setTimeout>;
  discard: boolean;
}

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  return MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type));
}

function endOfEditorRange(editor: HTMLElement): Range {
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  return range;
}

function rangeInsideEditor(editor: HTMLElement, range: Range): boolean {
  return editor.contains(range.startContainer) && editor.contains(range.endContainer);
}

function textBeforeRange(editor: HTMLElement, range: Range): string {
  const before = document.createRange();
  before.selectNodeContents(editor);
  before.setEnd(range.startContainer, range.startOffset);
  return before.toString().replace(/\u200B/g, '');
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

function RecordingElapsed(props: { startedAt: number }) {
  const now = useNow(250);
  return <span class="text-xs font-medium tabular-nums">{formatElapsed(now() - props.startedAt)}</span>;
}

export function DictationButton(props: { projectId: string; environmentId: string; host: () => HTMLElement }) {
  const [state, setState] = createSignal<DictationState>('idle');
  const [startedAt, setStartedAt] = createSignal(0);
  const [toolbarMount, setToolbarMount] = createSignal<HTMLElement>();
  const [graceExpired, setGraceExpired] = createSignal(false);
  const availability = useTranscriptionAvailability();
  const transcriptionAvailable = () => availability.data?.available === true;
  const idleTooltip = () => {
    if (transcriptionAvailable()) return 'Dictate';
    if (availability.data) {
      return 'Dictation is unavailable on this deployment. Configuring the OpenAI API-key option for the LLM gateway enables it.';
    }
    if (availability.isError) return 'Dictation availability could not be determined';
    return 'Checking dictation availability…';
  };

  createEffect(() => {
    const languages = availability.data?.languages;
    if (languages) reconcileDictationLanguage(languages);
  });

  const promptEditor = () => props.host().querySelector<HTMLElement>(PROMPT_EDITOR_SELECTOR);

  let active: ActiveRecording | undefined;
  let savedRange: Range | undefined;
  let retainedBlob: Blob | undefined;
  let retryToastId: string | number | undefined;

  onMount(() => {
    const container = document.createElement('div');
    container.className = 'flex items-center';

    const attach = () => {
      if (container.isConnected) return;
      const submit = props.host().querySelector(PROMPT_SUBMIT_SELECTOR);
      const parent = submit?.parentElement;
      if (!submit || !parent) {
        setToolbarMount(undefined);
        return;
      }
      parent.insertBefore(container, submit);
      setToolbarMount(container);
    };

    attach();
    const observer = new MutationObserver(attach);
    observer.observe(props.host(), { childList: true, subtree: true });
    const graceTimer = setTimeout(() => setGraceExpired(true), TOOLBAR_GRACE_MS);

    const trackSelection = () => {
      const editor = promptEditor();
      const selection = window.getSelection();
      if (!editor || !selection || selection.rangeCount === 0) return;
      const range = selection.getRangeAt(0);
      if (rangeInsideEditor(editor, range)) savedRange = range.cloneRange();
    };
    document.addEventListener('selectionchange', trackSelection);

    onCleanup(() => {
      observer.disconnect();
      clearTimeout(graceTimer);
      document.removeEventListener('selectionchange', trackSelection);
      container.remove();
      finishRecording(true);
    });
  });

  function insertTranscript(text: string): boolean {
    const editor = promptEditor();
    if (!editor) return false;
    editor.focus();
    const selection = window.getSelection();
    if (!selection) return false;
    const range = savedRange && rangeInsideEditor(editor, savedRange) ? savedRange : endOfEditorRange(editor);
    selection.removeAllRanges();
    selection.addRange(range);
    const before = textBeforeRange(editor, range);
    const spaced = before && !/\s$/.test(before) ? ` ${text}` : text;
    return document.execCommand('insertText', false, spaced);
  }

  async function deliverTranscript(text: string) {
    if (insertTranscript(text)) return;
    try {
      await navigator.clipboard.writeText(text);
      toast.info('Transcript copied to clipboard', {
        description: 'The prompt editor could not be found on the page.',
      });
    } catch {
      toast.error('Could not insert the transcript into the prompt', {
        duration: Number.POSITIVE_INFINITY,
        action: { label: 'Try again', onClick: () => void deliverTranscript(text) },
      });
    }
  }

  function dropRetainedRecording() {
    retainedBlob = undefined;
    if (retryToastId !== undefined) {
      toast.dismiss(retryToastId);
      retryToastId = undefined;
    }
  }

  function retryTranscription(blob: Blob) {
    if (retainedBlob !== blob || state() !== 'idle') return;
    retainedBlob = undefined;
    retryToastId = undefined;
    setState('transcribing');
    void transcribe(blob, true);
  }

  function reportTranscriptionFailure(blob: Blob, isRetry: boolean, status: number | undefined, message: string) {
    const budgetExhausted = status === 402;
    const title = budgetExhausted ? 'Project AI budget exhausted' : 'Transcription failed';
    const description = budgetExhausted
      ? 'The project has used up its AI budget, so the recording could not be transcribed. Increase the budget to keep dictating.'
      : message;
    if (isRetry) {
      toast.error(title, { description });
      return;
    }
    retainedBlob = blob;
    retryToastId = toast.error(title, {
      description,
      duration: Number.POSITIVE_INFINITY,
      action: { label: 'Retry', onClick: () => retryTranscription(blob) },
      onDismiss: () => {
        if (retainedBlob === blob) dropRetainedRecording();
      },
    });
  }

  async function transcribe(blob: Blob, isRetry = false) {
    const form = new FormData();
    form.append('file', blob, 'dictation');
    const language = dictationLanguage();
    if (language) form.append('language', language);
    const headers: Record<string, string> = {};
    const tenant = localStorage.getItem('tenant');
    if (tenant) headers['x-tenant-name'] = tenant;

    try {
      const response = await fetch(
        `/api/projects/${props.projectId}/transcription?environmentId=${encodeURIComponent(props.environmentId)}`,
        { method: 'POST', headers, body: form }
      );
      if (!response.ok) {
        const message = await extractErrorMessage(response, `Transcription failed (${response.status})`);
        reportTranscriptionFailure(blob, isRetry, response.status, message);
        return;
      }
      const payload = (await response.json()) as { text?: string };
      const text = (payload.text ?? '').trim();
      if (text) {
        await deliverTranscript(text);
      } else {
        toast.info('Nothing recognized', {
          description: 'The recording came back without any recognizable speech, so nothing was inserted.',
        });
      }
    } catch (err) {
      reportTranscriptionFailure(blob, isRetry, undefined, err instanceof Error ? err.message : String(err));
    } finally {
      setState('idle');
    }
  }

  async function startRecording() {
    if (state() !== 'idle') return;
    if (!transcriptionAvailable()) return;

    const mimeType = pickMimeType();
    if (!mimeType) {
      toast.error('Recording is not supported in this browser');
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        toast.error('Microphone access is blocked', {
          description:
            'Recording did not start because the browser denied microphone access. Allow the microphone for this site in your browser settings and try again.',
        });
      } else {
        toast.error('Could not start recording', {
          description: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    if (state() !== 'idle') {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }

    const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: AUDIO_BITS_PER_SECOND });
    const recording: ActiveRecording = {
      recorder,
      stream,
      chunks: [],
      capTimer: setTimeout(() => finishRecording(false), MAX_RECORDING_MS),
      discard: false,
    };

    recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) recording.chunks.push(event.data);
    });
    recorder.addEventListener('stop', () => {
      if (recording.discard) return;
      const blob = new Blob(recording.chunks, { type: recorder.mimeType || mimeType });
      void transcribe(blob);
    });
    recorder.addEventListener('error', () => {
      finishRecording(true);
      toast.error('Recording failed');
    });

    dropRetainedRecording();
    active = recording;
    recorder.start();
    setStartedAt(Date.now());
    setState('recording');
  }

  function finishRecording(discard: boolean) {
    const recording = active;
    if (!recording) return;
    active = undefined;
    clearTimeout(recording.capTimer);
    recording.discard = discard;
    if (recording.recorder.state !== 'inactive') recording.recorder.stop();
    recording.stream.getTracks().forEach((track) => track.stop());
    setState(discard ? 'idle' : 'transcribing');
  }

  function Controls() {
    return (
      <Switch>
        <Match when={state() === 'idle'}>
          <Tooltip>
            <TooltipTrigger
              as="button"
              type="button"
              onClick={() => void startRecording()}
              aria-label="Dictate"
              aria-disabled={!transcriptionAvailable() || undefined}
              class={cn(
                'relative flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors',
                transcriptionAvailable() ? 'hover:bg-accent hover:text-foreground' : 'cursor-not-allowed opacity-50'
              )}
            >
              <Mic class="h-4 w-4" />
            </TooltipTrigger>
            <TooltipContent class="max-w-60">{idleTooltip()}</TooltipContent>
          </Tooltip>
          <Show when={transcriptionAvailable()}>
            <DictationLanguageMenu languages={availability.data?.languages ?? []} />
          </Show>
        </Match>
        <Match when={state() === 'recording'}>
          <div class="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger
                as="button"
                type="button"
                onClick={() => finishRecording(false)}
                aria-label="Stop recording and transcribe"
                class="flex h-8 items-center gap-1.5 rounded-md bg-destructive/10 px-2.5 text-destructive transition-colors hover:bg-destructive/20"
              >
                <span class="relative flex h-2 w-2">
                  <span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-destructive opacity-75" />
                  <span class="relative inline-flex h-2 w-2 rounded-full bg-destructive" />
                </span>
                <RecordingElapsed startedAt={startedAt()} />
              </TooltipTrigger>
              <TooltipContent>Stop recording and transcribe</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                as="button"
                type="button"
                onClick={() => finishRecording(true)}
                aria-label="Discard recording"
                class="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <X class="h-4 w-4" />
              </TooltipTrigger>
              <TooltipContent>Discard recording</TooltipContent>
            </Tooltip>
          </div>
        </Match>
        <Match when={state() === 'transcribing'}>
          <div aria-label="Transcribing" class="flex h-8 w-8 items-center justify-center text-muted-foreground">
            <LoaderCircle class="h-4 w-4 animate-spin" />
          </div>
        </Match>
      </Switch>
    );
  }

  return (
    <Show
      when={toolbarMount()}
      keyed
      fallback={
        <Show when={graceExpired()}>
          <div class="shrink-0 border-t border-border bg-background px-3 py-1.5">
            <div class="flex items-center">
              <Controls />
            </div>
          </div>
        </Show>
      }
    >
      {(mount) => (
        <Portal mount={mount}>
          <div class="mr-1 flex items-center">
            <Controls />
          </div>
        </Portal>
      )}
    </Show>
  );
}
