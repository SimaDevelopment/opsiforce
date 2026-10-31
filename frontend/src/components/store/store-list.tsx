import { For, Show, createUniqueId, type Component, type ComponentProps, type JSX } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { useNavigate } from '@tanstack/solid-router';
import { Badge } from '~/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '~/components/ui/tooltip';
import {
  ArrowUp,
  ArrowUpDown,
  Box,
  Boxes,
  Building2,
  Cable,
  Globe,
  LayoutGrid,
  Lock,
  Package,
  Search,
  Tag,
} from '~/components/icons';
import type { Environment } from '~/api/environments';
import { EnvironmentBadge } from '~/components/environment-badge';
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
        navigate({ href: props.href });
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

export const KIND_ICONS = {
  all: LayoutGrid,
  shipped: Boxes,
  addons: Building2,
  built_in: Package,
  custom: Box,
  service: Cable,
} as const;

function ExplainedBadge(props: {
  variant: ComponentProps<typeof Badge>['variant'];
  icon?: Component<{ class?: string }>;
  explanation: string;
  class?: string;
  children: JSX.Element;
}) {
  return (
    <Tooltip>
      <TooltipTrigger as="span" class="inline-flex shrink-0">
        <Badge variant={props.variant} class={cn('gap-1 font-medium', props.class)}>
          <Show when={props.icon}>{(icon) => <Dynamic component={icon()} class="h-3 w-3" aria-hidden="true" />}</Show>
          {props.children}
        </Badge>
      </TooltipTrigger>
      <TooltipContent>{props.explanation}</TooltipContent>
    </Tooltip>
  );
}

export function OriginBadge(props: { origin: string }) {
  const builtIn = () => props.origin === 'built_in';
  return (
    <ExplainedBadge
      variant={builtIn() ? 'info' : 'outline'}
      icon={builtIn() ? KIND_ICONS.built_in : KIND_ICONS.custom}
      explanation={builtIn() ? 'Ships with the platform.' : 'Made in your organization.'}
    >
      {builtIn() ? 'Built-in' : 'Custom'}
    </ExplainedBadge>
  );
}

export function PackageBadge() {
  return (
    <ExplainedBadge
      variant="secondary"
      icon={KIND_ICONS.shipped}
      explanation="Comes with the agent and updates with platform releases."
    >
      Package
    </ExplainedBadge>
  );
}

export function ServiceBadge(props: { available: boolean }) {
  return (
    <ExplainedBadge
      variant={props.available ? 'outline' : 'warning'}
      icon={KIND_ICONS.service}
      explanation={
        props.available
          ? 'Comes from its External Service: each publish of the service lays the next version.'
          : 'Its External Service is disabled or not set up, so no agent gets this skill and it cannot be added.'
      }
    >
      {props.available ? 'Service' : 'Service unavailable'}
    </ExplainedBadge>
  );
}

export function ServiceMark(props: { externalServiceId: string | null; available: boolean }) {
  return (
    <Show when={props.externalServiceId}>
      <ServiceBadge available={props.available} />
    </Show>
  );
}

export function VisibilityBadge(props: { visibility: string }) {
  return (
    <Show
      when={props.visibility === 'private'}
      fallback={
        <ExplainedBadge variant="secondary" icon={Globe} explanation="Listed for everyone in your organization.">
          Public
        </ExplainedBadge>
      }
    >
      <ExplainedBadge variant="warning" icon={Lock} explanation="Listed only for the person who created it.">
        Private
      </ExplainedBadge>
    </Show>
  );
}

const DEFAULT_MARK_CLASS =
  'inline-flex cursor-default items-center rounded px-1 text-[0.625rem] font-semibold uppercase tracking-wide text-primary';

export function DefaultEnvironmentMark(props: { environmentName: string; plain?: boolean; explanation?: string }) {
  const explanation = () => props.explanation ?? `New projects start from ${props.environmentName}.`;
  return (
    <Show
      when={!props.plain}
      fallback={
        <span class={DEFAULT_MARK_CLASS} title={explanation()}>
          Default<span class="sr-only">: {explanation()}</span>
        </span>
      }
    >
      <Tooltip>
        <TooltipTrigger as="span" tabIndex={0} class={cn(DEFAULT_MARK_CLASS, FOCUS_RING)}>
          Default
        </TooltipTrigger>
        <TooltipContent>{explanation()}</TooltipContent>
      </Tooltip>
    </Show>
  );
}

export function DisabledBadge() {
  return (
    <ExplainedBadge variant="outline" class="text-muted-foreground" explanation="Switched off in your organization.">
      Disabled
    </ExplainedBadge>
  );
}

export function RetiredBadge() {
  return (
    <ExplainedBadge
      variant="outline"
      class="text-muted-foreground"
      explanation="The agent image no longer ships this skill: no agent gets it and it can't be added."
    >
      Retired
    </ExplainedBadge>
  );
}

export function UpdateBadge(props: { agentCount: number }) {
  return (
    <ExplainedBadge
      variant="warning"
      icon={ArrowUp}
      class="tabular-nums"
      explanation="A newer version is published. Each agent upgrades its pin on its own page."
    >
      Update available on {props.agentCount} agent{props.agentCount === 1 ? '' : 's'}
    </ExplainedBadge>
  );
}

export function VersionTag(props: { version: number; class?: string }) {
  return (
    <span
      class={cn(
        'inline-flex h-5 shrink-0 items-center gap-1 rounded-md border border-border bg-muted/40 px-1.5 font-mono text-[11px] font-semibold tabular-nums text-foreground',
        props.class
      )}
    >
      <Tag class="h-3 w-3 text-muted-foreground" aria-hidden="true" />v{props.version}
    </span>
  );
}

/** One pin sitting behind the latest version: `v2 → v4`. */
export function VersionUpdateBadge(props: { from: number; to: number }) {
  return (
    <ExplainedBadge
      variant="warning"
      icon={ArrowUp}
      class="tabular-nums"
      explanation={`Pinned to v${props.from}; v${props.to} is the latest.`}
    >
      v{props.from} → v{props.to}
    </ExplainedBadge>
  );
}

export { EmptyState } from '~/components/ui/empty-state';

export interface FilterChipOption<T extends string> {
  id: T;
  label: string;
  icon?: Component<{ class?: string }>;
  count?: number;
}

/** Native radios so one tab stop and arrow-key roving come for free. */
export function FilterChips<T extends string>(props: {
  options: FilterChipOption<T>[];
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
                'inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
                'has-[:focus-visible]:outline-none has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-ring',
                checked()
                  ? 'border-foreground/25 bg-muted text-foreground shadow-sm'
                  : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground'
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
              <Show when={option.icon}>
                {(icon) => <Dynamic component={icon()} class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
              </Show>
              {option.label}
              <Show when={option.count !== undefined}>
                <span
                  class={cn(
                    'min-w-[1.25rem] rounded-full px-1.5 text-center text-[10px] tabular-nums',
                    checked() ? 'bg-background text-foreground' : 'bg-muted text-muted-foreground'
                  )}
                >
                  {option.count}
                </span>
              </Show>
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

export function SortSelect<T extends string>(props: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  const selected = () => props.options.find((option) => option.id === props.value) ?? null;
  return (
    <Select<{ id: T; label: string }>
      options={props.options}
      optionValue="id"
      optionTextValue="label"
      value={selected()}
      onChange={(option) => option && props.onChange(option.id)}
      itemComponent={(itemProps) => <SelectItem item={itemProps.item}>{itemProps.item.rawValue.label}</SelectItem>}
    >
      <SelectTrigger aria-label="Sort by" class="h-9 w-auto shrink-0 gap-2 px-3 text-sm shadow-sm hover:bg-accent/40">
        <ArrowUpDown class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <SelectValue<{ id: T; label: string }> class="text-sm">{(state) => state.selectedOption()?.label}</SelectValue>
      </SelectTrigger>
      <SelectContent />
    </Select>
  );
}

export function ListToolbar(props: { search: JSX.Element; sort: JSX.Element; filters: JSX.Element }) {
  return (
    <div class="mb-4 flex flex-col gap-3">
      <div class="flex items-center gap-2">
        {props.search}
        {props.sort}
      </div>
      {props.filters}
    </div>
  );
}

export function EnvironmentList(props: {
  environments: Environment[];
  defaultEnvironmentId: string | null;
  defaultExplanation?: (environment: Environment) => string;
  label: string;
}) {
  return (
    <ul class="flex flex-wrap items-center gap-2" aria-label={props.label}>
      <For each={props.environments}>
        {(environment) => (
          <li class="inline-flex items-center gap-1">
            <EnvironmentBadge environment={environment} />
            <Show when={environment.id === props.defaultEnvironmentId}>
              <DefaultEnvironmentMark
                environmentName={environment.name}
                explanation={props.defaultExplanation?.(environment)}
                plain
              />
            </Show>
          </li>
        )}
      </For>
    </ul>
  );
}
