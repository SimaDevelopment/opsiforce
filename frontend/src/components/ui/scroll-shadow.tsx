import { createSignal, onCleanup, onMount, type ParentProps } from 'solid-js';
import { cn } from '~/lib/cn';

export function ScrollShadow(props: ParentProps<{ class?: string; label?: string }>) {
  const [moreAbove, setMoreAbove] = createSignal(false);
  const [moreBelow, setMoreBelow] = createSignal(false);
  let viewport!: HTMLDivElement;
  let content!: HTMLDivElement;

  const measure = () => {
    setMoreAbove(viewport.scrollTop > 1);
    setMoreBelow(viewport.scrollTop + viewport.clientHeight < viewport.scrollHeight - 1);
  };

  onMount(() => {
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(content);
    onCleanup(() => observer.disconnect());
  });

  return (
    <div class="relative">
      <div
        ref={viewport}
        onScroll={measure}
        role={props.label ? 'group' : undefined}
        aria-label={props.label}
        class={cn('overflow-y-auto overscroll-contain', props.class)}
      >
        <div ref={content}>{props.children}</div>
      </div>
      <div
        aria-hidden="true"
        class={cn(
          'pointer-events-none absolute inset-x-0 top-0 h-6 bg-gradient-to-b from-popover to-transparent transition-opacity duration-150',
          moreAbove() ? 'opacity-100' : 'opacity-0'
        )}
      />
      <div
        aria-hidden="true"
        class={cn(
          'pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-popover via-popover/70 to-transparent transition-opacity duration-150',
          moreBelow() ? 'opacity-100' : 'opacity-0'
        )}
      />
    </div>
  );
}
