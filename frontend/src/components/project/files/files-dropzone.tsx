import { Show } from 'solid-js';
import { Folder, Upload } from '~/components/icons';
import { cn } from '~/lib/cn';
import { formatBytes } from '~/lib/format-bytes';
import { toUploadFiles, type FileUpload } from '~/lib/upload';

export interface FilesDropzoneProps {
  upload: FileUpload;
  hint: string;
  dragging: boolean;
}

export function FilesDropzone(props: FilesDropzoneProps) {
  let fileInputRef: HTMLInputElement | undefined;
  let folderInputRef: HTMLInputElement | undefined;

  const pick = (input: HTMLInputElement) => {
    if (!input.files) return;
    const files = toUploadFiles(input.files);
    input.value = '';
    props.upload.upload(files);
  };

  return (
    <div
      class={cn(
        'relative flex h-10 items-center gap-2 rounded-lg border border-dashed px-3 transition-colors',
        props.dragging ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50'
      )}
    >
      <Show
        when={!props.upload.uploading()}
        fallback={
          <>
            <div class="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
              <div
                class="h-full rounded-full bg-primary transition-all duration-150"
                style={{ width: `${props.upload.percent()}%` }}
              />
            </div>
            <span class="text-xs text-muted-foreground tabular-nums">{props.upload.percent()}%</span>
            <span class="shrink-0 text-[0.6875rem] text-muted-foreground tabular-nums">
              <Show
                when={props.upload.totalBytes() > 0}
                fallback={`${props.upload.preparedFiles()} / ${props.upload.totalFiles()} files`}
              >
                {formatBytes(props.upload.sentBytes())} / {formatBytes(props.upload.totalBytes())}
              </Show>
            </span>
            <button
              type="button"
              class="inline-flex h-6 shrink-0 items-center rounded-md border border-border px-2 text-xs font-medium text-muted-foreground transition-colors hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive"
              onClick={() => props.upload.cancel()}
            >
              Cancel
            </button>
          </>
        }
      >
        <button
          type="button"
          class="absolute inset-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Choose files to upload"
          onClick={() => fileInputRef?.click()}
        />
        <Upload class="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
        <span class="pointer-events-none flex-1 min-w-0 truncate text-center text-xs text-muted-foreground">
          Drop files here or click to upload
        </span>
        <button
          type="button"
          class="relative inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md border border-border px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          onClick={() => folderInputRef?.click()}
        >
          <Folder class="w-3 h-3" />
          Folder
        </button>
        <span
          class="pointer-events-none shrink-0 max-w-1/3 truncate text-[0.6875rem] text-muted-foreground"
          title={props.hint}
        >
          {props.hint}
        </span>
      </Show>

      <input ref={fileInputRef} type="file" multiple class="hidden" onChange={(e) => pick(e.currentTarget)} />
      <input
        ref={folderInputRef}
        type="file"
        class="hidden"
        {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
        onChange={(e) => pick(e.currentTarget)}
      />
    </div>
  );
}
