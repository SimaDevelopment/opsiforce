import { Show, splitProps, untrack, type JSX, type ParentProps } from 'solid-js';
import { cn } from '~/lib/cn';
import { createElementWidth } from '~/lib/create-element-width';
import { TableLayoutSwitch, createTableLayoutPreference } from './table-layout-switch';

export type TableLayout = 'table' | 'responsive';

const CARDS_BELOW_WIDTH = 640;

export interface TableProps extends JSX.HTMLAttributes<HTMLTableElement> {
  layout?: TableLayout;
  layoutPreferenceKey?: string;
}

export function Table(props: ParentProps<TableProps>) {
  const [local, rest] = splitProps(props, ['class', 'children', 'layout', 'layoutPreferenceKey']);
  let frame: HTMLDivElement | undefined;
  const width = createElementWidth(() => frame, Number.POSITIVE_INFINITY);
  const preferenceKey = untrack(() => local.layoutPreferenceKey);
  const preference = preferenceKey ? createTableLayoutPreference(preferenceKey) : undefined;
  const narrow = () => local.layout === 'responsive' && width() < CARDS_BELOW_WIDTH;
  const cards = () => narrow() && preference?.choice() !== 'table';

  return (
    <div ref={frame} class="relative w-full">
      <Show when={narrow() && preference}>
        {(choice) => (
          <div class="flex justify-end border-b border-border px-2 py-1.5">
            <TableLayoutSwitch preference={choice()} />
          </div>
        )}
      </Show>
      <div class="w-full overflow-auto" data-table-layout={cards() ? 'cards' : 'table'}>
        <table class={cn('w-full caption-bottom text-sm', local.class)} {...rest}>
          {local.children}
        </table>
      </div>
    </div>
  );
}
