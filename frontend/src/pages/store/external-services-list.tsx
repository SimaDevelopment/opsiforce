import { For, Show, createEffect, createMemo, createSignal, on } from 'solid-js';
import type { SearchSchemaInput } from '@tanstack/solid-router';
import {
  isCustomServiceSummary,
  useOperatorServices,
  useTenantServices,
  type ExternalServiceSummary,
} from '~/api/external-service-views';
import { useEnvironments, type Environment } from '~/api/environments';
import { usePermissions } from '~/api/permissions';
import { useCurrentUser } from '~/api/user';
import { canManageExternalService, canSeeExternalServices } from '~/components/external-service/service-access';
import { NewExternalServiceDialog } from '~/components/external-service/new-external-service-dialog';
import { ImportServiceDialog } from '~/components/external-service/service-copy-dialogs';
import { NeedsSetupBadge, ServiceIcon } from '~/components/external-service/service-marks';
import { Pager, createOffsetPages } from '~/components/pager';
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
} from '~/components/store/store-list';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { Cable, ChevronRight, Plus, Upload } from '~/components/icons';
import { SORT_OPTIONS, createSearchDraft, sortStoreRows, validateSort, type StoreSort } from './store-filters';

export const EXTERNAL_SERVICE_FILTERS = [
  'all',
  'mine',
  'built_in',
  'custom',
  'not_published',
  'needs_setup',
  'disabled',
] as const;

export type ExternalServiceFilter = (typeof EXTERNAL_SERVICE_FILTERS)[number];

export interface ExternalServicesListSearch {
  filter: ExternalServiceFilter;
  q: string;
  sort: StoreSort;
}

export function validateExternalServicesSearch(
  search: Record<string, unknown> & SearchSchemaInput
): ExternalServicesListSearch {
  const filter = EXTERNAL_SERVICE_FILTERS.find((candidate) => candidate === search.filter);
  return { filter: filter ?? 'all', q: typeof search.q === 'string' ? search.q : '', sort: validateSort(search) };
}

type Audience = 'everyone' | 'operators' | 'tenantAdmins';

const FILTER_OPTIONS: { id: ExternalServiceFilter; label: string; audience: Audience }[] = [
  { id: 'all', label: 'All', audience: 'everyone' },
  { id: 'mine', label: 'Created by me', audience: 'tenantAdmins' },
  { id: 'built_in', label: 'Built-in', audience: 'everyone' },
  { id: 'custom', label: 'Custom', audience: 'everyone' },
  { id: 'not_published', label: 'Not published', audience: 'tenantAdmins' },
  { id: 'needs_setup', label: 'Needs setup', audience: 'operators' },
  { id: 'disabled', label: 'Disabled', audience: 'tenantAdmins' },
];

interface ServiceRow extends ExternalServiceSummary {
  needsSetup: boolean;
  viewOnly: boolean;
  disabled: boolean;
  hidesBuiltIn: boolean;
  createdBy: string | null;
  createdAt: string | null;
  publishedEnvironmentIds: string[] | null;
  defaultEnvironmentId: string | null;
  href: string;
}

function rowOf(service: ExternalServiceSummary, state: Pick<ServiceRow, 'needsSetup' | 'viewOnly'>): ServiceRow {
  const custom = isCustomServiceSummary(service) ? service : null;
  return {
    id: service.id,
    slug: service.slug,
    origin: service.origin,
    displayName: service.displayName,
    description: service.description,
    icon: service.icon,
    disabled: custom?.disabled ?? false,
    hidesBuiltIn: custom?.hidesBuiltIn ?? false,
    createdBy: custom?.createdBy ?? null,
    createdAt: custom?.createdAt ?? null,
    publishedEnvironmentIds: custom?.publishedEnvironmentIds ?? null,
    defaultEnvironmentId: custom?.defaultEnvironmentId ?? null,
    href: `/store/external-services/${service.id}`,
    ...state,
  };
}

function matchesQuery(row: ServiceRow, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return (
    row.displayName.toLowerCase().includes(needle) ||
    row.slug.includes(needle) ||
    row.description.toLowerCase().includes(needle)
  );
}

function matchesFilter(row: ServiceRow, filter: ExternalServiceFilter, userId: string | undefined): boolean {
  if (filter === 'disabled') return row.disabled;
  if (row.disabled) return false;
  if (filter === 'mine') return !!userId && row.createdBy === userId;
  if (filter === 'built_in' || filter === 'custom') return row.origin === filter;
  if (filter === 'not_published') return row.publishedEnvironmentIds?.length === 0;
  if (filter === 'needs_setup') return row.needsSetup;
  return true;
}

export function ExternalServicesListPage(props: {
  filter: ExternalServiceFilter;
  query: string;
  sort: StoreSort;
  onFilter: (filter: ExternalServiceFilter) => void;
  onQuery: (query: string) => void;
  onSort: (sort: StoreSort) => void;
}) {
  const { permissions, hasPermission } = usePermissions();
  const isOperator = () => canManageExternalService('built_in', hasPermission);
  const isTenantAdmin = () => canManageExternalService('custom', hasPermission);
  const operatorServices = useOperatorServices(isOperator);
  const tenantServices = useTenantServices(isTenantAdmin);
  const environments = useEnvironments();
  const currentUser = useCurrentUser();
  const search = createSearchDraft(
    () => props.query,
    (query) => props.onQuery(query)
  );
  const filterOptions = () =>
    FILTER_OPTIONS.filter(
      (option) =>
        option.audience === 'everyone' ||
        (option.audience === 'operators' && isOperator()) ||
        (option.audience === 'tenantAdmins' && isTenantAdmin())
    );
  const filter = () => (filterOptions().some((option) => option.id === props.filter) ? props.filter : 'all');

  const loading = () =>
    permissions.data === undefined ||
    (isOperator() && operatorServices.data === undefined) ||
    (isTenantAdmin() && tenantServices.data === undefined);
  const failed = () => operatorServices.isError || tenantServices.isError;

  const allRows = createMemo((): ServiceRow[] => {
    const rows: ServiceRow[] = (isOperator() ? (operatorServices.data ?? []) : []).map((service) =>
      rowOf(service, { needsSetup: !service.available, viewOnly: false })
    );
    const known = new Set(rows.map((row) => row.id));
    for (const service of isTenantAdmin() ? (tenantServices.data ?? []) : []) {
      if (known.has(service.id)) continue;
      rows.push(
        rowOf(service, { needsSetup: false, viewOnly: !canManageExternalService(service.origin, hasPermission) })
      );
    }
    return rows;
  });

  const rows = createMemo(() =>
    sortStoreRows(
      allRows().filter((row) => matchesFilter(row, filter(), currentUser.data?.id) && matchesQuery(row, props.query)),
      props.sort,
      { label: (row) => row.displayName, createdAt: (row) => row.createdAt }
    )
  );
  const pages = createOffsetPages(rows);
  createEffect(on([filter, () => props.query, () => props.sort], () => pages.toFirst(), { defer: true }));

  const narrowed = () => filter() !== 'all' || props.query.trim().length > 0;
  const [createOpen, setCreateOpen] = createSignal(false);
  const [importOpen, setImportOpen] = createSignal(false);

  return (
    <SettingsSection
      icon={Cable}
      title="External Services"
      description="Services your agents and Apps call through the platform. Each service is configured here; every Project chooses what it may use."
      width="wide"
      action={
        <Show when={isTenantAdmin()}>
          <div class="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>
              <Upload class="h-4 w-4" aria-hidden="true" />
              Import service
            </Button>
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus class="h-4 w-4" aria-hidden="true" />
              New External Service
            </Button>
          </div>
        </Show>
      }
    >
      <Show
        when={permissions.data === undefined || canSeeExternalServices(hasPermission)}
        fallback={
          <EmptyState
            icon={Cable}
            title="External Services are managed by platform operators and Organization admins."
            hint="Ask an admin if you need a service set up."
          />
        }
      >
        <ListToolbar
          search={<SearchInput value={search.draft()} onInput={search.onInput} label="Search External Services" />}
          sort={<SortSelect options={SORT_OPTIONS} value={props.sort} onChange={props.onSort} />}
          filters={
            <FilterChips
              label="Filter External Services"
              options={filterOptions()}
              value={filter()}
              onChange={props.onFilter}
            />
          }
        />

        <Show when={!failed()} fallback={<ErrorState message="The External Services could not be loaded." />}>
          <Show
            when={!loading()}
            fallback={
              <div class="flex justify-center py-10">
                <Spinner />
              </div>
            }
          >
            <Show
              when={rows().length > 0}
              fallback={
                <Show when={narrowed()} fallback={<EmptyState icon={Cable} title="No External Services yet." />}>
                  <EmptyState
                    icon={Cable}
                    title="No External Services match."
                    hint="Try another filter, or clear the search."
                  />
                </Show>
              }
            >
              <RowList>
                <For each={pages.page()}>
                  {(row) => <ServiceListRow row={row} environments={environments.data ?? []} />}
                </For>
                <Show when={pages.needsPager()}>
                  <Pager {...pages.pagerProps()} />
                </Show>
              </RowList>
            </Show>
          </Show>
        </Show>
      </Show>

      <NewExternalServiceDialog open={createOpen()} onOpenChange={setCreateOpen} />
      <ImportServiceDialog open={importOpen()} onOpenChange={setImportOpen} />
    </SettingsSection>
  );
}

function ServiceEnvironments(props: { row: ServiceRow; environments: Environment[] }) {
  const development = () => props.environments.find((environment) => environment.isDefault);
  const holding = () =>
    props.environments.filter(
      (environment) => environment.isDefault || props.row.publishedEnvironmentIds?.includes(environment.id)
    );
  const notPublished = () => props.row.publishedEnvironmentIds?.length === 0;

  return (
    <Show
      when={props.row.publishedEnvironmentIds}
      fallback={<div class="mt-1.5 text-xs text-muted-foreground">Every environment</div>}
    >
      <div class="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
        <EnvironmentList
          environments={holding()}
          defaultEnvironmentId={props.row.defaultEnvironmentId}
          defaultExplanation={(environment) => `Callers reach ${environment.name}.`}
          label="Environments holding this service"
        />
        <Show when={notPublished() && development()}>
          <span class="text-xs text-muted-foreground">Not published yet</span>
        </Show>
      </div>
    </Show>
  );
}

function ServiceListRow(props: { row: ServiceRow; environments: Environment[] }) {
  return (
    <RowLink href={props.row.href} class="p-4">
      <ServiceIcon icon={props.row.icon} name={props.row.displayName} class="h-4 w-4" />
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span class="text-sm font-medium">{props.row.displayName}</span>
          <span class="font-mono text-[11px] text-muted-foreground" translate="no">
            {props.row.slug}
          </span>
          <OriginBadge origin={props.row.origin} />
          <Show when={props.row.disabled}>
            <DisabledBadge />
          </Show>
          <Show when={props.row.needsSetup}>
            <NeedsSetupBadge />
          </Show>
        </div>
        <Show when={props.row.description}>
          <div class="mt-0.5 truncate text-xs text-muted-foreground">{props.row.description}</div>
        </Show>
        <ServiceEnvironments row={props.row} environments={props.environments} />
        <Show when={props.row.hidesBuiltIn}>
          <div class="mt-1.5 text-xs text-amber-800">
            A built-in service now has this name too. It stays hidden in your Organization, so your agents keep reaching
            this one.
          </div>
        </Show>
        <Show when={props.row.viewOnly}>
          <div class="mt-1.5 text-xs text-muted-foreground">View only</div>
        </Show>
      </div>
      <ChevronRight class="h-4 w-4 shrink-0 text-muted-foreground/50" aria-hidden="true" />
    </RowLink>
  );
}
