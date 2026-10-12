import { Show, createEffect, createSignal, on, type JSX } from 'solid-js';
import { Button } from '~/components/ui/button';
import { ChevronLeft, ChevronRight } from '~/components/icons';

export const PAGE_SIZE = 25;

export interface PagerProps {
  from: number;
  to: number;
  total?: number;
  hasPrevious: boolean;
  hasNext: boolean;
  previousLabel?: string;
  nextLabel?: string;
  onPrevious: () => void;
  onNext: () => void;
  note?: JSX.Element;
}

export function Pager(props: PagerProps) {
  return (
    <div class="flex items-center gap-3 border-t border-border px-4 py-2.5">
      <span class="text-xs tabular-nums text-muted-foreground">
        {props.to === 0 ? 'Nothing to show' : `${props.from}–${props.to}`}
        <Show when={props.total !== undefined && props.to > 0}> of {props.total?.toLocaleString()}</Show>
      </span>
      <Show when={props.note}>
        <span class="text-xs text-muted-foreground/70">{props.note}</span>
      </Show>
      <div class="ml-auto flex items-center gap-1.5">
        <Button
          variant="outline"
          size="sm"
          class="h-7 px-2.5 text-xs"
          disabled={!props.hasPrevious}
          onClick={() => props.onPrevious()}
        >
          <ChevronLeft class="h-3.5 w-3.5" aria-hidden="true" />
          {props.previousLabel ?? 'Previous'}
        </Button>
        <Button
          variant="outline"
          size="sm"
          class="h-7 px-2.5 text-xs"
          disabled={!props.hasNext}
          onClick={() => props.onNext()}
        >
          {props.nextLabel ?? 'Next'}
          <ChevronRight class="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

export interface CursorPage {
  newer: string | null;
  older: string | null;
}

export type PageCursor = { older: string } | { newer: string } | null;

export function cursorQuery(cursor: PageCursor): Record<string, string> {
  if (cursor === null) return {};
  return 'older' in cursor ? { older: cursor.older } : { newer: cursor.newer };
}

export function createCursorPages(pageSize = PAGE_SIZE) {
  const [cursor, setCursor] = createSignal<PageCursor>(null);
  const [pageIndex, setPageIndex] = createSignal(0);

  const indexOf = (page: CursorPage | undefined) => (page?.newer === null ? 0 : pageIndex());

  return {
    cursor,
    toFirst: () => {
      setCursor(null);
      setPageIndex(0);
    },
    pagerProps: (page: CursorPage | undefined, rowCount: number): PagerProps => ({
      from: indexOf(page) * pageSize + 1,
      to: indexOf(page) * pageSize + rowCount,
      hasPrevious: Boolean(page?.newer),
      hasNext: Boolean(page?.older),
      previousLabel: 'Newer',
      nextLabel: 'Older',
      onPrevious: () => {
        if (!page?.newer) return;
        setPageIndex(Math.max(0, indexOf(page) - 1));
        setCursor({ newer: page.newer });
      },
      onNext: () => {
        if (!page?.older) return;
        setPageIndex(indexOf(page) + 1);
        setCursor({ older: page.older });
      },
    }),
  };
}

export function createOffsetPages<T>(rows: () => readonly T[], pageSize = PAGE_SIZE) {
  const [offset, setOffset] = createSignal(0);

  createEffect(
    on(
      () => rows().length,
      (length) => {
        if (offset() >= length) setOffset(0);
      },
      { defer: true }
    )
  );

  const page = () => rows().slice(offset(), offset() + pageSize);

  return {
    page,
    needsPager: () => rows().length > pageSize,
    toFirst: () => setOffset(0),
    pagerProps: (): PagerProps => ({
      from: offset() + 1,
      to: offset() + page().length,
      total: rows().length,
      hasPrevious: offset() > 0,
      hasNext: offset() + pageSize < rows().length,
      onPrevious: () => setOffset(Math.max(0, offset() - pageSize)),
      onNext: () => setOffset(offset() + pageSize),
    }),
  };
}
