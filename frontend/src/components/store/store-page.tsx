import { Show, type Component, type JSX } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { Link } from '@tanstack/solid-router';
import { ChevronLeft } from '~/components/icons';
import { cn } from '~/lib/cn';
import { FOCUS_RING } from './store-list';

export function StorePageHeader(props: {
  backTo: string;
  backLabel: string;
  icon?: Component<{ class?: string }>;
  title: JSX.Element;
  mono?: boolean;
  badges?: JSX.Element;
  description?: string | null;
  meta?: JSX.Element;
  actions?: JSX.Element;
}) {
  return (
    <header class="mb-6">
      <Link
        to={props.backTo}
        class={cn(
          '-ml-1 mb-3 inline-flex max-w-full items-center gap-1 rounded-md px-1 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground',
          FOCUS_RING
        )}
      >
        <ChevronLeft class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span class="truncate">{props.backLabel}</span>
      </Link>
      <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2">
            <Show when={props.icon}>
              {(icon) => (
                <Dynamic component={icon()} class="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
              )}
            </Show>
            <h1
              class={cn(
                'min-w-0 text-balance text-xl font-semibold tracking-tight text-foreground',
                props.mono && 'font-mono'
              )}
            >
              {props.title}
            </h1>
            {props.badges}
          </div>
          <Show when={props.description}>
            <p class="mt-1.5 max-w-2xl text-pretty text-sm text-muted-foreground">{props.description}</p>
          </Show>
          <Show when={props.meta}>
            <div class="mt-1.5 text-xs text-muted-foreground">{props.meta}</div>
          </Show>
        </div>
        <Show when={props.actions}>
          <div class="flex shrink-0 flex-wrap items-center gap-2">{props.actions}</div>
        </Show>
      </div>
      <div class="mt-4 h-px bg-border" />
    </header>
  );
}
