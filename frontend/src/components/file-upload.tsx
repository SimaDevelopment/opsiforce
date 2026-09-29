import { Show, type Component } from 'solid-js';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '~/components/ui/dropdown-menu';
import { Upload, File, Folder, ChevronDown } from '~/components/icons';
import { uploadUrl } from '~/api/files';
import { formatBytes } from '~/lib/format-bytes';
import { createFileUpload, toUploadFiles, topLevelEntriesOf } from '~/lib/upload';

export const FileUpload: Component<{ projectId: string; environmentId: string; host: () => HTMLElement }> = (props) => {
  let fileInputRef: HTMLInputElement | undefined;
  let folderInputRef: HTMLInputElement | undefined;

  const upload = createFileUpload({
    url: () => uploadUrl(props.projectId, props.environmentId),
    onUploaded: (files, result) => {
      if (result.uploaded > 0) injectUploadSummary(props.host(), topLevelEntriesOf(files));
    },
  });

  const pick = (input: HTMLInputElement) => {
    if (!input.files) return;
    const files = toUploadFiles(input.files);
    input.value = '';
    upload.upload(files);
  };

  return (
    <>
      <div class="shrink-0 border-t border-border bg-background px-3 py-2">
        <Show
          when={!upload.uploading()}
          fallback={
            <div class="flex flex-col gap-1.5">
              <div class="flex h-7 items-center gap-3">
                <div class="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                  <div
                    class="h-full bg-primary rounded-full transition-all duration-150"
                    style={{ width: `${upload.percent()}%` }}
                  />
                </div>
                <span class="text-xs text-muted-foreground tabular-nums w-9 text-right">{upload.percent()}%</span>
                <button
                  onClick={() => upload.cancel()}
                  class="inline-flex h-7 items-center rounded-md border border-border px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive"
                >
                  Cancel
                </button>
              </div>
              <div class="flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
                <span class="truncate" title={upload.statusLabel()}>
                  {upload.statusLabel() || 'Uploading…'}
                </span>
                <span class="tabular-nums shrink-0">
                  <Show
                    when={upload.totalBytes() > 0}
                    fallback={`${upload.preparedFiles()} / ${upload.totalFiles()} files`}
                  >
                    {formatBytes(upload.sentBytes())} / {formatBytes(upload.totalBytes())}
                  </Show>
                </span>
              </div>
            </div>
          }
        >
          <div class="flex h-7 items-center">
            <DropdownMenu>
              <DropdownMenuTrigger class="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-[expanded]:bg-accent data-[expanded]:text-foreground">
                <Upload class="h-3.5 w-3.5" />
                Upload
                <ChevronDown class="h-3 w-3 opacity-60" />
              </DropdownMenuTrigger>
              <DropdownMenuContent class="min-w-36">
                <DropdownMenuItem onSelect={() => fileInputRef?.click()}>
                  <File class="h-3.5 w-3.5" />
                  Files
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => folderInputRef?.click()}>
                  <Folder class="h-3.5 w-3.5" />
                  Folder
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </Show>
      </div>

      <input ref={fileInputRef} type="file" multiple class="hidden" onChange={(e) => pick(e.currentTarget)} />
      <input
        ref={folderInputRef}
        type="file"
        class="hidden"
        {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
        onChange={(e) => pick(e.currentTarget)}
      />
    </>
  );
};

function injectUploadSummary(host: HTMLElement, entries: string[]) {
  if (entries.length === 0) return;
  const editor = host.querySelector<HTMLDivElement>('[data-component="composer-editor"]');
  if (!editor) return;
  editor.focus();

  const PREFIX = 'Uploaded files: ';
  const existing = editor.innerText;
  const lastIdx = existing.lastIndexOf(PREFIX);

  let next: string;
  if (lastIdx >= 0) {
    const lineEnd = existing.indexOf('\n', lastIdx);
    const endPos = lineEnd === -1 ? existing.length : lineEnd;
    next = existing.slice(0, endPos) + ', ' + entries.join(', ') + existing.slice(endPos);
  } else {
    const hasContent = /[^\u200B]/.test(editor.textContent ?? '');
    next = (hasContent ? existing + '\n\n' : '') + `${PREFIX}${entries.join(', ')}`;
  }

  const range = document.createRange();
  range.selectNodeContents(editor);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  document.execCommand('insertText', false, next);
}
