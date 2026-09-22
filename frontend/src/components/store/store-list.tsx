import { For, Show, createUniqueId, type Component, type JSX } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { useNavigate } from '@tanstack/solid-router';
import { Badge } from '~/components/ui/badge';
import { ArrowUp, Box, Globe, Lock, Package, Search } from '~/components/icons';
import { cn } from '~/lib/cn';

export const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

function isPlainClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

export function RowLink(props: { href: string; class?: string; children: JSX.Element }) {
  const navigate = useNavigate();

  return (
    <a
      href={props.href}
      onClick={(event) => {
        if (!isPlainClick(event)) return;
        event.preventDefault();
        navigate({ to: props.href });
      }}
      class={cn(
        'flex w-full items-center gap-3 text-left transition-colors first:rounded-t-xl last:rounded-b-xl hover:bg-accent/40',
        FOCUS_RING,
        props.class
      )}
    >
      {props.children}
    </a>
  );
}

export function SectionTitle(props: { children: JSX.Element; action?: JSX.Element }) {
  return (
    <div class="mb-2 flex items-center justify-between gap-2">
      <h2 class="text-sm font-semibold text-foreground">{props.children}</h2>
      <Show when={props.action}>{props.action}</Show>
    </div>
  );
}

export function RowList(props: { children: JSX.Element }) {
  return <div class="divide-y divide-border rounded-xl border border-border bg-card">{props.children}</div>;
}

export function OriginBadge(props: { origin: string }) {
  const builtIn = () => props.origin === 'built_in';
  return (
    <Badge variant={builtIn() ? 'info' : 'outline'} class="gap-1 font-medium">
      <Show when={builtIn()} fallback={<Box class="h-3 w-3" aria-hidden="true" />}>
        <Package class="h-3 w-3" aria-hidden="true" />
      </Show>
      {builtIn() ? 'Built-in' : 'Custom'}
    </Badge>
  );
}

export function VisibilityBadge(props: { visibility: string }) {
  return (
    <Show
      when={props.visibility === 'private'}
      fallback={
        <Badge variant="secondary" class="gap-1 font-medium">
          <Globe class="h-3 w-3" aria-hidden="true" />
          Public
        </Badge>
      }
    >
      <Badge variant="warning" class="gap-1 font-medium">
        <Lock class="h-3 w-3" aria-hidden="true" />
        Private
      </Badge>
    </Show>
  );
}

export function ArchivedBadge() {
  return (
    <Badge variant="outline" class="font-medium text-muted-foreground">
      Archived
    </Badge>
  );
}

export function UpdateBadge(props: { agentCount: number }) {
  return (
    <Badge variant="warning" class="gap-1 font-medium tabular-nums">
      <ArrowUp class="h-3 w-3" aria-hidden="true" />
      Update available on {props.agentCount} agent{props.agentCount === 1 ? '' : 's'}
    </Badge>
  );
}

/** One pin sitting behind the latest version: `v2 → v4`. */
export function VersionUpdateBadge(props: { from: number; to: number }) {
  return (
    <Badge variant="warning" class="gap-1 font-medium tabular-nums">
      <ArrowUp class="h-3 w-3" aria-hidden="true" />v{props.from} → v{props.to}
    </Badge>
  );
}

export function EmptyState(props: { icon: Component<{ class?: string }>; title: string; hint?: string }) {
  return (
    <div class="rounded-xl border border-border bg-card p-10 text-center">
      <Dynamic component={props.icon} class="mx-auto mb-3 h-10 w-10 text-muted-foreground/30" aria-hidden="true" />
      <p class="text-sm text-muted-foreground">{props.title}</p>
      <Show when={props.hint}>
        <p class="mt-1 text-xs text-muted-foreground/60">{props.hint}</p>
      </Show>
    </div>
  );
}

/** Native radios so one tab stop and arrow-key roving come for free. */
export function FilterChips<T extends string>(props: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  const group = `filter-${createUniqueId()}`;
  return (
    <fieldset class="flex flex-wrap gap-1 border-0 p-0">
      <legend class="sr-only">{props.label}</legend>
      <For each={props.options}>
        {(option) => {
          const checked = () => props.value === option.id;
          return (
            <label
              class={cn(
                'cursor-pointer rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
                'has-[:focus-visible]:outline-none has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-ring',
                checked()
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'border-border text-muted-foreground hover:bg-accent'
              )}
            >
              <input
                type="radio"
                name={group}
                class="sr-only"
                value={option.id}
                checked={checked()}
                onChange={() => props.onChange(option.id)}
              />
              {option.label}
            </label>
          );
        }}
      </For>
    </fieldset>
  );
}

export function ErrorState(props: { message: string }) {
  return (
    <div class="rounded-xl border border-destructive/40 bg-card p-10 text-center" role="alert">
      <p class="text-sm text-destructive">{props.message}</p>
    </div>
  );
}

export function SearchInput(props: { value: string; onInput: (value: string) => void; label: string }) {
  return (
    <div class="relative flex-1">
      <Search class="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden="true" />
      <input
        type="search"
        name="q"
        autocomplete="off"
        spellcheck={false}
        aria-label={props.label}
        placeholder={`${props.label}…`}
        value={props.value}
        onInput={(event) => props.onInput(event.currentTarget.value)}
        class={cn(
          'h-9 w-full rounded-md border border-input bg-background pl-8 pr-3 text-sm shadow-sm outline-none transition-colors placeholder:text-muted-foreground',
          'focus-visible:ring-1 focus-visible:ring-ring'
        )}
      />
    </div>
  );
}
