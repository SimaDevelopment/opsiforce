import { For, Show, type JSX } from 'solid-js';
import type { Environment } from '~/api/environments';
import { EnvironmentBadge } from '~/components/environment-badge';
import { FOCUS_RING } from '~/components/store/store-list';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select';
import { cn } from '~/lib/cn';

export type EnvironmentChoice = Pick<Environment, 'id' | 'name' | 'slug' | 'shortName' | 'color'>;

export function PublishTargetList<T extends EnvironmentChoice>(props: {
  targets: T[];
  chosen: string | null;
  onPick: (environmentId: string) => void;
  status: (environment: T) => string;
  stale?: (environment: T) => boolean;
}) {
  return (
    <div class="space-y-1.5" role="radiogroup" aria-label="Target environment">
      <For each={props.targets}>
        {(environment) => (
          <button
            type="button"
            role="radio"
            aria-checked={props.chosen === environment.id}
            onClick={() => props.onPick(environment.id)}
            class={cn(
              'flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left transition-colors',
              FOCUS_RING,
              props.chosen === environment.id ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent'
            )}
          >
            <span class="inline-flex items-center gap-1.5">
              <EnvironmentBadge environment={environment} />
              <span class="text-xs font-medium text-foreground">{environment.name}</span>
            </span>
            <span
              class={cn('text-right text-xs', props.stale?.(environment) ? 'text-amber-700' : 'text-muted-foreground')}
            >
              {props.status(environment)}
            </span>
          </button>
        )}
      </For>
    </div>
  );
}

export function PublishPreviewCard(props: { title: string; children: JSX.Element }) {
  return (
    <div class="overflow-hidden rounded-lg border border-border">
      <div class="border-b border-border bg-muted/40 px-3 py-1.5 text-[11px] font-medium text-muted-foreground">
        {props.title}
      </div>
      <div class="divide-y divide-border">{props.children}</div>
    </div>
  );
}

export function DefaultEnvironmentSetting<T extends EnvironmentChoice>(props: {
  id: string;
  label: string;
  description: string;
  choices: T[];
  value: T | null;
  onChange: (environment: T) => void;
  disabled?: boolean;
  notice?: JSX.Element;
}) {
  return (
    <div class="rounded-lg border border-border">
      <div class="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between">
        <div class="min-w-0">
          <label for={props.id} class="text-xs font-medium text-foreground">
            {props.label}
          </label>
          <div class="mt-0.5 text-xs text-muted-foreground">{props.description}</div>
        </div>
        <div class="w-full sm:w-44">
          <Select<T>
            options={props.choices}
            optionValue="id"
            optionTextValue="name"
            value={props.value}
            disabled={props.disabled}
            onChange={(option) => option && props.onChange(option)}
            itemComponent={(itemProps) => (
              <SelectItem item={itemProps.item}>
                <span class="flex items-center gap-1.5">
                  <EnvironmentBadge environment={itemProps.item.rawValue} />
                  {itemProps.item.rawValue.name}
                </span>
              </SelectItem>
            )}
          >
            <SelectTrigger id={props.id} aria-label={props.label} class="h-8">
              <SelectValue<T>>
                {(state) => (
                  <span class="flex items-center gap-1.5">
                    <Show when={state.selectedOption()}>
                      {(environment) => <EnvironmentBadge environment={environment()} />}
                    </Show>
                    {state.selectedOption()?.name ?? 'Select'}
                  </span>
                )}
              </SelectValue>
            </SelectTrigger>
            <SelectContent />
          </Select>
        </div>
      </div>
      <Show when={props.notice}>
        {(notice) => <p class="border-t border-border px-3 py-2 text-xs text-amber-700">{notice()}</p>}
      </Show>
    </div>
  );
}
