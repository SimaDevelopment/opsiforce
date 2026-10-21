import type { ParentProps } from 'solid-js';
import { cn } from '~/lib/cn';

export function OptionCardGroup(props: ParentProps<{ label: string; class?: string }>) {
  return (
    <div role="radiogroup" aria-label={props.label} class={cn('grid gap-2', props.class)}>
      {props.children}
    </div>
  );
}

export function OptionCard(
  props: ParentProps<{ selected: boolean; onSelect: () => void; disabled?: boolean; class?: string }>
) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={props.selected}
      disabled={props.disabled}
      onClick={() => props.onSelect()}
      class={cn(
        'flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        props.selected ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent/40',
        props.class
      )}
    >
      {props.children}
    </button>
  );
}
