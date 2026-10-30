import { Show } from 'solid-js';
import { Folder } from '~/components/icons';
import { cn } from '~/lib/cn';
import { fileExtensionOf } from '~/lib/file-extension';
import type { FileEntryType } from '~/api/files';

/**
 * The hue here is identity, not status: a spreadsheet is green because it is a
 * spreadsheet. So the map names a file KIND and the tone tokens decide what
 * that kind looks like — which is why a mode flip or a contrast change needs
 * nothing from this file.
 */
const EXTENSION_TONE: Record<string, string> = {
  pdf: 'of-tone-pdf',
  doc: 'of-tone-doc',
  docx: 'of-tone-doc',
  ppt: 'of-tone-slide',
  pptx: 'of-tone-slide',
  xls: 'of-tone-sheet',
  xlsx: 'of-tone-sheet',
  csv: 'of-tone-sheet',
  md: 'of-tone-text',
  txt: 'of-tone-text',
  png: 'of-tone-image',
  jpg: 'of-tone-image',
  jpeg: 'of-tone-image',
  gif: 'of-tone-image',
  svg: 'of-tone-image',
  zip: 'of-tone-neutral',
};

export function FileTypeBadge(props: { name: string; type: FileEntryType; class?: string }) {
  const extension = () => fileExtensionOf(props.name);

  return (
    <Show
      when={props.type === 'file'}
      fallback={
        <span
          class={cn(
            'shrink-0 flex items-center justify-center rounded-md of-tone of-tone-accent',
            props.class ?? 'w-8 h-8'
          )}
        >
          <Folder class="w-4 h-4" />
        </span>
      }
    >
      <span
        class={cn(
          'shrink-0 flex items-center justify-center rounded-md font-bold uppercase overflow-hidden of-tone',
          EXTENSION_TONE[extension()] ?? 'of-tone-neutral',
          props.class ?? 'w-8 h-8'
        )}
      >
        {extension().slice(0, 4) || '·'}
      </span>
    </Show>
  );
}
