import { For, Show, type JSX } from 'solid-js';
import type { Environment } from '~/api/environments';
import { EnvironmentBadge } from '~/components/environment-badge';
import { ChevronRight } from '~/components/icons';
import { cn } from '~/lib/cn';
import { DefaultEnvironmentMark, FOCUS_RING, RowList, SectionTitle } from './store-list';

export interface EnvironmentRowStatus {
  text: string;
  stale: boolean;
}

export function EnvironmentSplit(props: { children: JSX.Element; list: JSX.Element }) {
  return (
    <div class="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-8">
      {props.children}
      <aside class="order-first lg:order-none lg:sticky lg:top-4 lg:self-start">
        <SectionTitle>Environments</SectionTitle>
        {props.list}
      </aside>
    </div>
  );
}

export function EnvironmentList(props: {
  environments: Environment[];
  selectedId: string;
  defaultEnvironmentId: string | null;
  defaultExplanation?: string;
  statusOf: (environment: Environment) => EnvironmentRowStatus;
  onEnv: (environmentId: string) => void;
}) {
  return (
    <RowList>
      <For each={props.environments}>
        {(environment) => {
          const selected = () => environment.id === props.selectedId;
          const status = () => props.statusOf(environment);
          return (
            <button
              type="button"
              aria-pressed={selected()}
              onClick={() => props.onEnv(environment.id)}
              class={cn(
                'group flex w-full cursor-pointer items-center gap-3 px-3 py-2.5 text-left transition-colors first:rounded-t-xl last:rounded-b-xl hover:bg-accent/60',
                FOCUS_RING,
                selected() && 'bg-accent'
              )}
            >
              <span class="min-w-0 flex-1 space-y-0.5">
                <span class="flex items-center gap-1.5 text-sm font-medium text-foreground">
                  <EnvironmentBadge environment={environment} />
                  <span class="truncate">{environment.name}</span>
                  <Show when={props.defaultEnvironmentId === environment.id}>
                    <DefaultEnvironmentMark
                      environmentName={environment.name}
                      explanation={props.defaultExplanation}
                      plain
                    />
                  </Show>
                </span>
                <span class={cn('block truncate text-xs', status().stale ? 'text-amber-700' : 'text-muted-foreground')}>
                  {status().text}
                </span>
              </span>
              <ChevronRight
                class={cn(
                  'h-4 w-4 shrink-0 transition-transform group-hover:translate-x-0.5',
                  selected() ? 'text-foreground' : 'text-muted-foreground'
                )}
                aria-hidden="true"
              />
            </button>
          );
        }}
      </For>
    </RowList>
  );
}
