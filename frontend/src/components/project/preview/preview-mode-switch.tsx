import { For } from 'solid-js';
import { cn } from '~/lib/cn';

export type PreviewMode = 'app' | 'file' | 'desktop';

const PREVIEW_MODE_LABELS: Record<PreviewMode, string> = { app: 'App', file: 'File', desktop: 'Screen' };

export interface PreviewModeSwitchProps {
  modes: PreviewMode[];
  mode: PreviewMode;
  /** Overrides a mode's name, e.g. the Desktop reads as Browser when a browser is all it shows. */
  labels?: Partial<Record<PreviewMode, string>>;
  onChange: (mode: PreviewMode) => void;
}

export function PreviewModeSwitch(props: PreviewModeSwitchProps) {
  return (
    <div
      role="group"
      aria-label="Preview"
      class="flex items-center h-6 rounded-md border border-border overflow-hidden shrink-0"
    >
      <For each={props.modes}>
        {(mode) => (
          <button
            type="button"
            aria-pressed={props.mode === mode}
            class={cn(
              'h-full px-2 text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring',
              props.mode === mode
                ? 'bg-accent font-medium text-foreground'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
            )}
            onClick={() => props.onChange(mode)}
          >
            {props.labels?.[mode] ?? PREVIEW_MODE_LABELS[mode]}
          </button>
        )}
      </For>
    </div>
  );
}
