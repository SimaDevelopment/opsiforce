import { Show, type ParentProps } from 'solid-js';
import { useLimitUsage } from '~/api/limits';
import { Minus, Plus } from '~/components/icons';
import { cn } from '~/lib/cn';

export function WarmPoolPicker(props: {
  value: number;
  max: number;
  onChange: (size: number) => void;
  disabled?: boolean;
  countedAlready?: number;
}) {
  const usage = useLimitUsage();
  const limit = () => {
    const entry = usage.data?.find((candidate) => candidate.key === 'warm_pool');
    return entry && entry.limit !== null ? { used: entry.used, limit: entry.limit } : null;
  };
  const ceiling = () => {
    const entry = limit();
    if (!entry) return props.max;
    return Math.min(props.max, Math.max(props.value, entry.limit - entry.used + (props.countedAlready ?? 0)));
  };
  const usedAfter = () => {
    const entry = limit();
    return entry ? entry.used - (props.countedAlready ?? 0) + props.value : 0;
  };

  return (
    <div class="space-y-1.5">
      <div class="flex items-center justify-between gap-4">
        <div class="min-w-0">
          <span class="block text-xs font-medium text-foreground">Ready Projects</span>
          <p class="text-xs text-muted-foreground/70">New Projects open instantly instead of waiting to start.</p>
        </div>
        <div class="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          <span>Keep</span>
          <div
            role="group"
            aria-label="Ready Projects to keep"
            class="flex items-center rounded-md border border-border"
          >
            <StepButton
              label="Keep fewer ready"
              disabled={props.disabled || props.value <= 0}
              onClick={() => props.onChange(props.value - 1)}
            >
              <Minus class="h-3.5 w-3.5" />
            </StepButton>
            <span class="w-8 text-center font-medium text-foreground tabular-nums" aria-live="polite">
              {props.value}
            </span>
            <StepButton
              label="Keep more ready"
              disabled={props.disabled || props.value >= ceiling()}
              onClick={() => props.onChange(props.value + 1)}
            >
              <Plus class="h-3.5 w-3.5" />
            </StepButton>
          </div>
          <span>ready</span>
        </div>
      </div>
      <Show when={limit()}>
        {(entry) => (
          <p class="text-right text-xs text-muted-foreground/70 tabular-nums">
            {usedAfter()} of {entry().limit} Ready Projects used across the organization
          </p>
        )}
      </Show>
    </div>
  );
}

function StepButton(props: ParentProps<{ label: string; disabled: boolean; onClick: () => void }>) {
  return (
    <button
      type="button"
      aria-label={props.label}
      disabled={props.disabled}
      onClick={() => props.onClick()}
      class={cn(
        'flex h-7 w-7 items-center justify-center text-muted-foreground transition-colors',
        'hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30'
      )}
    >
      {props.children}
    </button>
  );
}
