import { Match, Show, Switch } from 'solid-js';
import { Markdown } from '@opencode/session-ui/components/markdown';
import { FileDownloadCard } from './file-download-card';
import { createFileFetch, type FileFetchState } from './file-fetch';
import { FilePreviewNotice } from './file-preview-notice';
import { textPreviewLanguage } from './file-preview-format';
import { MAX_TEXT_PREVIEW_BYTES, SNIFF_BYTE_COUNT } from './file-preview-limits';

interface TextContent {
  text: string;
  truncated: boolean;
}

export interface FileTextPreviewProps {
  url: string;
  name: string;
  markdown: boolean;
  onDownload: () => void;
}

export function FileTextPreview(props: FileTextPreviewProps) {
  const state = createFileFetch(() => props.url, readText, MAX_TEXT_PREVIEW_BYTES);
  const content = () => loadedText(state());

  const source = () => {
    const current = content();
    if (!current) return '';
    return props.markdown ? current.text : fencedCode(current.text, textPreviewLanguage(props.name));
  };

  return (
    <Switch>
      <Match when={state().status === 'loading'}>
        <FilePreviewNotice title="Loading preview…" loading />
      </Match>
      <Match when={state().status === 'missing'}>
        <FilePreviewNotice title="File not found" detail="It may have been renamed, moved, or deleted." />
      </Match>
      <Match when={state().status === 'error'}>
        <FilePreviewNotice title="Could not load this file" detail="Try again, or download it instead." />
      </Match>
      <Match when={content()}>
        {(loaded) => (
          <div class="h-full overflow-auto p-4">
            <Markdown text={source()} />
            <Show when={loaded().truncated}>
              <p class="mt-4 text-xs text-muted-foreground">Preview truncated — download the file to read all of it.</p>
            </Show>
          </div>
        )}
      </Match>
      <Match when={state().status === 'ready'}>
        <FileDownloadCard
          name={props.name}
          detail="This file is not text, so it cannot be shown here."
          onDownload={props.onDownload}
        />
      </Match>
    </Switch>
  );
}

function loadedText(state: FileFetchState<TextContent | null>): TextContent | null {
  return state.status === 'ready' ? state.value : null;
}

async function readText(response: Response): Promise<TextContent | null> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.subarray(0, SNIFF_BYTE_COUNT).includes(0)) return null;

  const truncated = bytes.byteLength > MAX_TEXT_PREVIEW_BYTES;
  const text = new TextDecoder().decode(truncated ? bytes.subarray(0, MAX_TEXT_PREVIEW_BYTES) : bytes);
  return { text, truncated };
}

function fencedCode(text: string, language: string): string {
  const backtickRuns = text.match(/`+/g) ?? [];
  const longestRun = backtickRuns.reduce((longest, run) => Math.max(longest, run.length), 2);
  const fence = '`'.repeat(longestRun + 1);
  return `${fence}${language}\n${text}\n${fence}`;
}
