import { For, Show } from 'solid-js';
import { Download, Trash2 } from '~/components/icons';
import { ToolbarButton } from '~/components/ui/toolbar-button';
import { formatBytes } from '~/lib/format-bytes';
import { FileTypeBadge } from './file-type-badge';
import { formatDate } from '~/lib/format-date';
import type { FileEntry } from '~/api/files';

export interface FilesCardsProps {
  entries: FileEntry[];
  onOpen: (entry: FileEntry) => void;
  onDownload: (entry: FileEntry) => void;
  onDelete: (entry: FileEntry) => void;
}

export function FilesCards(props: FilesCardsProps) {
  return (
    <div class="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-3">
      <For each={props.entries}>
        {(entry) => (
          <div class="group relative border border-border rounded-xl bg-background hover:border-primary/50 hover:shadow-sm transition-colors">
            <button
              type="button"
              class="absolute inset-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={entry.type === 'directory' ? `Open folder ${entry.name}` : `Open ${entry.name}`}
              onClick={() => props.onOpen(entry)}
            />
            <div class="p-3 flex flex-col gap-2.5 pointer-events-none">
              <div class="flex items-start justify-between gap-2">
                <FileTypeBadge name={entry.name} type={entry.type} class="w-9 h-9 text-[10px]" />
                <div class="relative flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 pointer-events-auto">
                  <Show when={entry.type === 'file'}>
                    <ToolbarButton tooltip="Download" onClick={() => props.onDownload(entry)}>
                      <Download class="w-3.5 h-3.5" />
                    </ToolbarButton>
                  </Show>
                  <ToolbarButton tooltip="Delete" onClick={() => props.onDelete(entry)}>
                    <Trash2 class="w-3.5 h-3.5 text-destructive" />
                  </ToolbarButton>
                </div>
              </div>
              <div class="min-w-0">
                <div class="text-sm font-medium truncate" title={entry.name}>
                  {entry.name}
                </div>
                <div class="text-xs text-muted-foreground">
                  <Show when={entry.type === 'file'} fallback={formatDate(entry.modifiedAt)}>
                    {formatBytes(entry.size)} · {formatDate(entry.modifiedAt)}
                  </Show>
                </div>
              </div>
            </div>
          </div>
        )}
      </For>
    </div>
  );
}
