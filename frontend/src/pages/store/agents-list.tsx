import { For, Show, createMemo, createSignal } from 'solid-js';
import { useStoreAgents, type StoreAgent } from '~/api/agents';
import { useEnvironments, type Environment } from '~/api/environments';
import { usePermissions } from '~/api/permissions';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { EnvironmentBadge } from '~/components/environment-badge';
import { CreateEntryDialog } from '~/components/store/create-entry-dialog';
import { SettingsSection } from '~/components/settings/settings-section';
import {
  DefaultEnvironmentMark,
  DisabledBadge,
  EmptyState,
  ErrorState,
  FilterChips,
  OriginBadge,
  RowLink,
  RowList,
  SearchInput,
  VisibilityBadge,
} from '~/components/store/store-list';
import { Bot, ChevronRight, Plus } from '~/components/icons';
import { Permission } from '~/constants/permissions';
import { createSearchDraft, filterOptions, type StoreListProps } from './store-filters';

export function AgentsListPage(props: StoreListProps) {
  const { hasPermission } = usePermissions();
  const canManage = () => hasPermission(Permission.manageAgents);
  const search = createSearchDraft(
    () => props.query,
    (query) => props.onQuery(query)
  );
  const filter = () => (props.filter === 'disabled' && !canManage() ? 'all' : props.filter);
  const agents = useStoreAgents(
    filter,
    () => props.query
  );
  const environments = useEnvironments();
  const [createOpen, setCreateOpen] = createSignal(false);
  const narrowed = () => filter() !== 'all' || props.query.trim().length > 0;

  const byId = createMemo(() => new Map((environments.data ?? []).map((environment) => [environment.id, environment])));

  return (
    <SettingsSection
      icon={Bot}
      title="Agents"
      description="Built-in agents ship with the platform. Custom agents hold one definition per environment — edit Development, then publish it onward."
      width="wide"
      action={
        <Show when={canManage()}>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus class="h-4 w-4" aria-hidden="true" />
            New agent
          </Button>
        </Show>
      }
    >
      <div class="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <SearchInput value={search.draft()} onInput={search.onInput} label="Search agents" />
        <FilterChips
          label="Filter agents"
          options={filterOptions(canManage())}
          value={filter()}
          onChange={props.onFilter}
        />
      </div>

      <Show when={!agents.isError} fallback={<ErrorState message="The agents could not be loaded." />}>
        <Show
          when={agents.data}
          fallback={
            <div class="flex justify-center py-10">
              <Spinner />
            </div>
          }
        >
          {(rows) => (
            <Show when={rows().length > 0} fallback={<AgentsEmptyState narrowed={narrowed()} />}>
              <RowList>
                <For each={rows()}>{(agent) => <AgentRow agent={agent} environmentById={byId()} />}</For>
              </RowList>
            </Show>
          )}
        </Show>
      </Show>

      <CreateEntryDialog type="agent" open={createOpen()} onOpenChange={setCreateOpen} />
    </SettingsSection>
  );
}

function AgentsEmptyState(props: { narrowed: boolean }) {
  return (
    <Show
      when={props.narrowed}
      fallback={<EmptyState icon={Bot} title="No agents yet." hint="New agent creates the first one." />}
    >
      <EmptyState icon={Bot} title="No agents match." hint="Try another filter, or clear the search." />
    </Show>
  );
}

function AgentRow(props: { agent: StoreAgent; environmentById: Map<string, Environment> }) {
  const published = () =>
    props.agent.profileEnvironmentIds
      .map((id) => props.environmentById.get(id))
      .filter((environment): environment is Environment => !!environment);

  return (
    <RowLink href={`/store/agents/${props.agent.id}`} class="p-4">
      <Bot class="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span class="text-sm font-medium">{props.agent.displayName ?? props.agent.name}</span>
          <span class="font-mono text-[11px] text-muted-foreground">{props.agent.name}</span>
          <OriginBadge origin={props.agent.origin} />
          <Show when={props.agent.visibility === 'private'}>
            <VisibilityBadge visibility="private" />
          </Show>
          <Show when={props.agent.disabled}>
            <DisabledBadge />
          </Show>
        </div>
        <Show when={props.agent.description}>
          <div class="mt-0.5 truncate text-xs text-muted-foreground">{props.agent.description}</div>
        </Show>
        <Show when={props.agent.origin === 'built_in'}>
          <div class="mt-1.5 text-xs text-muted-foreground">Every environment</div>
        </Show>
        <Show when={props.agent.origin !== 'built_in' && published().length > 0}>
          <ul class="mt-1.5 flex flex-wrap items-center gap-2" aria-label="Environments holding a definition">
            <For each={published()}>
              {(environment) => {
                const isDefault = () => environment.id === props.agent.defaultEnvironmentId;
                return (
                  <li class="inline-flex items-center gap-1">
                    <EnvironmentBadge environment={environment} />
                    <Show when={isDefault()}>
                      <DefaultEnvironmentMark environmentName={environment.name} plain />
                    </Show>
                  </li>
                );
              }}
            </For>
          </ul>
        </Show>
      </div>
      <ChevronRight class="h-4 w-4 shrink-0 text-muted-foreground/50" aria-hidden="true" />
    </RowLink>
  );
}
