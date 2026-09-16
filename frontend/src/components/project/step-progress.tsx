import { For, Show } from 'solid-js';
import { Check, LoaderCircle, X } from '~/components/icons';
import { cn } from '~/lib/cn';

export type StepState = 'done' | 'active' | 'pending' | 'failed';

export interface ProgressStep {
  label: string;
  detail: string;
}

export interface StepProgressProps {
  steps: ProgressStep[];
  currentIndex: number;
  isFailed: boolean;
  isDone: boolean;
}

export function StepProgress(props: StepProgressProps) {
  const stepState = (index: number): StepState => {
    if (props.isDone) return 'done';
    if (index < props.currentIndex) return 'done';
    if (index === props.currentIndex) return props.isFailed ? 'failed' : 'active';
    return 'pending';
  };

  return (
    <ol class="relative space-y-1">
      <For each={props.steps}>
        {(step, index) => {
          const state = () => stepState(index());
          const isLast = index() === props.steps.length - 1;
          return (
            <li class="relative flex gap-3 pb-1">
              <div class="relative flex flex-col items-center">
                <StepMarker state={state()} />
                <Show when={!isLast}>
                  <span
                    class={cn(
                      'absolute top-5 h-[calc(100%-0.25rem)] w-px',
                      state() === 'done' ? 'bg-emerald-500/40' : 'bg-border'
                    )}
                  />
                </Show>
              </div>
              <div class="min-w-0 pb-2">
                <p
                  class={cn(
                    'text-xs font-medium leading-5 transition-colors',
                    state() === 'active' && 'text-foreground',
                    state() === 'done' && 'text-foreground',
                    state() === 'failed' && 'text-destructive',
                    state() === 'pending' && 'text-muted-foreground'
                  )}
                >
                  {step.label}
                </p>
                <Show when={state() === 'active' || state() === 'failed'}>
                  <p class="text-xs text-muted-foreground">{step.detail}</p>
                </Show>
              </div>
            </li>
          );
        }}
      </For>
    </ol>
  );
}

function StepMarker(props: { state: StepState }) {
  return (
    <span
      class={cn(
        'z-10 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 bg-background transition-colors',
        props.state === 'done' && 'border-emerald-500 bg-emerald-500 text-white',
        props.state === 'active' && 'border-primary text-primary',
        props.state === 'failed' && 'border-destructive bg-destructive text-white',
        props.state === 'pending' && 'border-border text-muted-foreground'
      )}
    >
      <Show when={props.state === 'done'}>
        <Check class="h-3 w-3" />
      </Show>
      <Show when={props.state === 'active'}>
        <LoaderCircle class="h-3 w-3 animate-spin" />
      </Show>
      <Show when={props.state === 'failed'}>
        <X class="h-3 w-3" />
      </Show>
    </span>
  );
}
