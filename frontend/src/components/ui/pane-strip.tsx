import {
  Show,
  createContext,
  createEffect,
  createSignal,
  on,
  onCleanup,
  onMount,
  useContext,
  type Accessor,
  type JSX,
} from 'solid-js';
import { createMediaQuery } from '@solid-primitives/media';
import { ChevronLeft, ChevronRight } from '~/components/icons';
import { createElementWidth } from '~/lib/create-element-width';
import { cn } from '~/lib/cn';

const LEGACY_WIDTH_KEY = 'opsiforce:pane-strip:width';

export interface PaneStripSlot {
  pane: 'first' | 'second';
  width: Accessor<number>;
  alone: Accessor<boolean>;
}

const PaneStripContext = createContext<PaneStripSlot>();

export function usePaneStripSlot(): PaneStripSlot | undefined {
  return useContext(PaneStripContext);
}

export interface PaneStripProps {
  first: JSX.Element;
  second?: JSX.Element;
  hasSecond: boolean;
  revealSecond: number;
}

export function PaneStrip(props: PaneStripProps) {
  let scroller: HTMLDivElement | undefined;
  let firstPane: HTMLDivElement | undefined;
  let secondPane: HTMLDivElement | undefined;

  const hoverCapable = createMediaQuery('(hover: hover)');
  const stripWidth = createElementWidth(() => scroller, typeof window === 'undefined' ? 1280 : window.innerWidth);

  const [scrollLeft, setScrollLeft] = createSignal(0);
  const [overflow, setOverflow] = createSignal(0);

  const syncScroll = () => {
    if (!scroller) return;
    setScrollLeft(scroller.scrollLeft);
    setOverflow(scroller.scrollWidth - scroller.clientWidth);
  };

  onMount(() => {
    try {
      window.localStorage.removeItem(LEGACY_WIDTH_KEY);
    } catch {}
    if (!scroller) return;
    syncScroll();
    const observer = new ResizeObserver(syncScroll);
    observer.observe(scroller);
    if (firstPane) observer.observe(firstPane);
    onCleanup(() => observer.disconnect());
  });

  createEffect(
    on(
      () => props.hasSecond,
      (hasSecond) => {
        queueMicrotask(syncScroll);
        if (!hasSecond || !secondPane) return;
        const observer = new ResizeObserver(syncScroll);
        observer.observe(secondPane);
        onCleanup(() => observer.disconnect());
      }
    )
  );

  const maxScroll = () => (scroller ? scroller.scrollWidth - scroller.clientWidth : 0);
  const scrollTo = (left: number) =>
    scroller?.scrollTo({ left: Math.max(0, Math.min(left, maxScroll())), behavior: 'smooth' });

  const stops = () => {
    const second = props.hasSecond && secondPane ? secondPane.offsetLeft : null;
    return [0, ...(second === null ? [] : [second]), maxScroll()].filter(
      (stop, index, all) => all.indexOf(stop) === index
    );
  };
  const scrollBack = () => {
    const before = stops().filter((stop) => stop < scrollLeft() - 1);
    scrollTo(before.length > 0 ? before[before.length - 1] : 0);
  };
  const scrollOn = () => {
    const after = stops().find((stop) => stop > scrollLeft() + 1);
    scrollTo(after ?? maxScroll());
  };

  createEffect(
    on(
      () => props.revealSecond,
      () => {
        if (!scroller || !secondPane) return;
        const start = secondPane.offsetLeft;
        scrollTo(Math.max(start, start + secondPane.offsetWidth - scroller.clientWidth));
      },
      { defer: true }
    )
  );

  const canScrollBack = () => scrollLeft() > 1;
  const canScrollOn = () => overflow() - scrollLeft() > 1;
  const showArrows = () => hoverCapable() && overflow() > 1;

  const firstSlot: PaneStripSlot = { pane: 'first', width: stripWidth, alone: () => !props.hasSecond };
  const secondSlot: PaneStripSlot = { pane: 'second', width: stripWidth, alone: () => false };

  return (
    <div class="relative flex h-full w-full min-h-0">
      <div
        ref={scroller}
        onScroll={syncScroll}
        class={cn(
          'flex h-full w-full min-h-0 flex-1 overflow-x-auto overflow-y-hidden overscroll-x-contain snap-x',
          hoverCapable() ? 'snap-proximity' : 'snap-mandatory'
        )}
      >
        <div
          ref={firstPane}
          class={cn('relative flex min-h-0 flex-col border-r border-border', props.hasSecond ? 'shrink-0' : 'w-full')}
        >
          <PaneStripContext.Provider value={firstSlot}>{props.first}</PaneStripContext.Provider>
        </div>

        <Show when={props.hasSecond}>
          <div ref={secondPane} class="flex min-h-0 shrink-0 flex-col border-r border-border">
            <PaneStripContext.Provider value={secondSlot}>{props.second}</PaneStripContext.Provider>
          </div>
          <div class="strip-tail w-6 shrink-0" aria-hidden="true" />
        </Show>
      </div>

      <Show when={showArrows()}>
        <Show when={canScrollBack()}>
          <StripArrow side="left" onClick={scrollBack} />
        </Show>
        <Show when={canScrollOn()}>
          <StripArrow side="right" onClick={scrollOn} />
        </Show>
      </Show>
    </div>
  );
}

function StripArrow(props: { side: 'left' | 'right'; onClick: () => void }) {
  const label = () => (props.side === 'left' ? 'Scroll left' : 'Scroll right');
  return (
    <button
      type="button"
      onClick={() => props.onClick()}
      aria-label={label()}
      title={label()}
      class={cn(
        'absolute top-1/2 z-20 flex h-9 w-7 -translate-y-1/2 items-center justify-center rounded-md border border-border bg-background/90 text-muted-foreground shadow-sm backdrop-blur transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        props.side === 'left' ? 'left-1' : 'right-1'
      )}
    >
      <Show when={props.side === 'left'} fallback={<ChevronRight class="h-4 w-4" />}>
        <ChevronLeft class="h-4 w-4" />
      </Show>
    </button>
  );
}
