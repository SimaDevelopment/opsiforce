import { Show, type Component, type JSX } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { cn } from '~/lib/cn';

export function SettingsSection(props: {
  icon: Component<{ class?: string }>;
  title: string;
  description: string;
  action?: JSX.Element;
  width?: 'default' | 'wide';
  children: JSX.Element;
}) {
  return (
    <div class="h-full overflow-y-auto bg-background">
      <div class={cn('mx-auto w-full px-4 py-6 sm:px-6 sm:py-8', props.width === 'wide' ? 'max-w-6xl' : 'max-w-5xl')}>
        <header class="mb-6">
          <div class="flex items-start justify-between gap-4">
            <div class="flex items-center gap-2.5">
              <Dynamic component={props.icon} class="h-5 w-5 shrink-0 text-muted-foreground" />
              <h1 class="text-xl font-semibold tracking-tight text-foreground">{props.title}</h1>
            </div>
            <Show when={props.action}>
              <div class="shrink-0">{props.action}</div>
            </Show>
          </div>
          <p class="mt-1.5 text-sm text-muted-foreground">{props.description}</p>
          <div class="mt-4 h-px bg-border" />
        </header>
        {props.children}
      </div>
    </div>
  );
}
