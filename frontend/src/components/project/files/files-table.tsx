import { For, Show } from 'solid-js';
import { Download, Trash2 } from '~/components/icons';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';
import { ToolbarButton } from '~/components/ui/toolbar-button';
import { formatBytes } from '~/lib/format-bytes';
import { FileTypeBadge } from './file-type-badge';
import { formatDate } from '~/lib/format-date';
import type { FileEntry } from '~/api/files';

export interface FilesTableProps {
  entries: FileEntry[];
  onOpen: (entry: FileEntry) => void;
  onDownload: (entry: FileEntry) => void;
  onDelete: (entry: FileEntry) => void;
}

export function FilesTable(props: FilesTableProps) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead class="w-24">Size</TableHead>
          <TableHead class="w-32">Modified</TableHead>
          <TableHead class="w-20" />
        </TableRow>
      </TableHeader>
      <TableBody>
        <For each={props.entries}>
          {(entry) => (
            <TableRow class="group">
              <TableCell class="p-0">
                <button
                  type="button"
                  class="w-full flex items-center gap-2.5 min-w-0 text-left px-3 py-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                  aria-label={entry.type === 'directory' ? `Open folder ${entry.name}` : `Open ${entry.name}`}
                  onClick={() => props.onOpen(entry)}
                >
                  <FileTypeBadge name={entry.name} type={entry.type} class="w-6 h-6 text-[8px]" />
                  <span class="truncate">{entry.name}</span>
                </button>
              </TableCell>
              <TableCell class="text-xs text-muted-foreground tabular-nums">
                <Show when={entry.type === 'file'} fallback="—">
                  {formatBytes(entry.size)}
                </Show>
              </TableCell>
              <TableCell class="text-xs text-muted-foreground">{formatDate(entry.modifiedAt)}</TableCell>
              <TableCell class="py-1">
                <div class="flex items-center justify-end gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                  <Show when={entry.type === 'file'}>
                    <ToolbarButton tooltip="Download" onClick={() => props.onDownload(entry)}>
                      <Download class="w-3.5 h-3.5" />
                    </ToolbarButton>
                  </Show>
                  <ToolbarButton tooltip="Delete" onClick={() => props.onDelete(entry)}>
                    <Trash2 class="w-3.5 h-3.5 text-destructive" />
                  </ToolbarButton>
                </div>
              </TableCell>
            </TableRow>
          )}
        </For>
      </TableBody>
    </Table>
  );
}
