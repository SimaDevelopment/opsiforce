import { createSignal, onCleanup, type JSX } from 'solid-js';
import { Info } from '~/components/icons';
import { cn } from '~/lib/cn';
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip';

/** Hover shows it on desktop; a tap pins it where there is no hover, and the next tap anywhere unpins it. */
export function InfoTip(props: { label: string; children: JSX.Element; class?: string }) {
  const [hovered, setHovered] = createSignal(false);
  const [pinned, setPinned] = createSignal(false);
  let trigger: HTMLButtonElement | undefined;

  const unpinOutside = (event: PointerEvent) => {
    if (trigger && !trigger.contains(event.target as Node)) setPinned(false);
  };
  document.addEventListener('pointerdown', unpinOutside, true);
  onCleanup(() => document.removeEventListener('pointerdown', unpinOutside, true));

  return (
    <Tooltip open={hovered() || pinned()} onOpenChange={setHovered}>
      <TooltipTrigger
        ref={trigger}
        as="button"
        type="button"
        aria-label={props.label}
        class={cn(
          'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          props.class
        )}
        onClick={(event: MouseEvent) => {
          event.preventDefault();
          event.stopPropagation();
          setPinned(!pinned());
        }}
      >
        <Info class="h-3.5 w-3.5" aria-hidden="true" />
      </TooltipTrigger>
      <TooltipContent>{props.children}</TooltipContent>
    </Tooltip>
  );
}
