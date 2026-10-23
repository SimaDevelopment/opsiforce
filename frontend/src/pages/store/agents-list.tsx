import { For, Show, createEffect, createMemo, createSignal, on } from 'solid-js';
import { useStoreAgents, type StoreAgent } from '~/api/agents';
import { useEnvironments, type Environment } from '~/api/environments';
import { usePermissions } from '~/api/permissions';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { Pager, createOffsetPages } from '~/components/pager';
import { CreateEntryDialog } from '~/components/store/create-entry-dialog';
import { ImportAgentDialog } from '~/components/store/import-agent-dialog';
import { SettingsSection } from '~/components/settings/settings-section';
import {
  DisabledBadge,
  EmptyState,
  EnvironmentList,
  ErrorState,
  FilterChips,
  ListToolbar,
  OriginBadge,
  RowLink,
  RowList,
  SearchInput,
  SortSelect,
  VisibilityBadge,
} from '~/components/store/store-list';
import { Bot, ChevronRight, Plus, Upload } from '~/components/icons';
import { SORT_OPTIONS, createSearchDraft, filterOptions, sortStoreRows, type StoreListProps } from './store-filters';

export function AgentsListPage(props: StoreListProps) {
  const { hasPermission } = usePermissions();
  const canManage = () => hasPermission('can_manage_agents');
  const canImport = () => canManage() && hasPermission('can_manage_skills');
  const search = createSearchDraft(
    () => props.query,
    (query) => props.onQuery(query)
  );
  const filter = () => (props.filter === 'disabled' && !canManage() ? 'all' : props.filter);
  const agents = useStoreAgents(filter, () => props.query);
  const environments = useEnvironments();
  const [createOpen, setCreateOpen] = createSignal(false);
  const [importOpen, setImportOpen] = createSignal(false);
  const narrowed = () => filter() !== 'all' || props.query.trim().length > 0;

  const byId = createMemo(() => new Map((environments.data ?? []).map((environment) => [environment.id, environment])));
  const sorted = createMemo(() =>
    sortStoreRows(agents.data ?? [], props.sort, {
      label: (agent) => agent.displayName ?? agent.name,
      createdAt: (agent) => (agent.origin === 'built_in' ? null : agent.createdAt),
    })
  );
  const pages = createOffsetPages(() => sorted());
  createEffect(on([filter, () => props.query, () => props.sort], () => pages.toFirst(), { defer: true }));

  return (
    <SettingsSection
      icon={Bot}
      title="Agents"
      description="Built-in agents ship with the platform. Custom agents hold one definition per environment — edit Development, then publish it onward."
      width="wide"
      action={
        <Show when={canManage()}>
          <div class="flex gap-2">
            <Show when={canImport()}>
              <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>
                <Upload class="h-4 w-4" aria-hidden="true" />
                Import agent
              </Button>
            </Show>
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus class="h-4 w-4" aria-hidden="true" />
              New agent
            </Button>
          </div>
        </Show>
      }
    >
      <ListToolbar
        search={<SearchInput value={search.draft()} onInput={search.onInput} label="Search agents" />}
        sort={<SortSelect options={SORT_OPTIONS} value={props.sort} onChange={props.onSort} />}
        filters={
          <FilterChips
            label="Filter agents"
            options={filterOptions(canManage())}
            value={filter()}
            onChange={props.onFilter}
          />
        }
      />

      <Show when={!agents.isError} fallback={<ErrorState message="The agents could not be loaded." />}>
        <Show
          when={agents.data}
          fallback={
            <div class="flex justify-center py-10">
              <Spinner />
            </div>
          }
        >
          <Show when={sorted().length > 0} fallback={<AgentsEmptyState narrowed={narrowed()} />}>
            <RowList>
              <For each={pages.page()}>{(agent) => <AgentRow agent={agent} environmentById={byId()} />}</For>
              <Show when={pages.needsPager()}>
                <Pager {...pages.pagerProps()} />
              </Show>
            </RowList>
          </Show>
        </Show>
      </Show>

      <CreateEntryDialog type="agent" open={createOpen()} onOpenChange={setCreateOpen} />
      <ImportAgentDialog open={importOpen()} onOpenChange={setImportOpen} />
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
          <div class="mt-1.5">
            <EnvironmentList
              environments={published()}
              defaultEnvironmentId={props.agent.defaultEnvironmentId}
              label="Environments holding a definition"
            />
          </div>
        </Show>
      </div>
      <ChevronRight class="h-4 w-4 shrink-0 text-muted-foreground/50" aria-hidden="true" />
    </RowLink>
  );
}
