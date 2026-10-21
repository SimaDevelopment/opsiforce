import { For, type Component } from 'solid-js';
import { cn } from '~/lib/cn';

export interface ViewToggleOption<T extends string> {
  value: T;
  label: string;
  icon: Component<{ class?: string }>;
}

export interface ViewToggleProps<T extends string> {
  value: T;
  options: ViewToggleOption<T>[];
  onChange: (value: T) => void;
  class?: string;
}

export function ViewToggle<T extends string>(props: ViewToggleProps<T>) {
  return (
    <div class={cn('flex items-center rounded-md border border-border p-0.5 shrink-0', props.class)}>
      <For each={props.options}>
        {(option) => (
          <button
            type="button"
            class={cn(
              'p-1 rounded',
              props.value === option.value ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'
            )}
            title={option.label}
            aria-label={option.label}
            aria-pressed={props.value === option.value}
            onClick={() => props.onChange(option.value)}
          >
            <option.icon class="w-3.5 h-3.5" />
          </button>
        )}
      </For>
    </div>
  );
}
