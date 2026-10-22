import { For, Show, createEffect, createMemo, createSignal, on } from 'solid-js';
import type { SearchSchemaInput } from '@tanstack/solid-router';
import {
  isCustomServiceSummary,
  useOperatorServices,
  useTenantServices,
  type ExternalServiceSummary,
} from '~/api/external-service-views';
import { usePermissions } from '~/api/permissions';
import { canManageExternalService, canSeeExternalServices } from '~/components/external-service/service-access';
import { NewExternalServiceDialog } from '~/components/external-service/new-external-service-dialog';
import { ImportServiceDialog } from '~/components/external-service/service-copy-dialogs';
import { NeedsSetupBadge, ServiceIcon } from '~/components/external-service/service-marks';
import { Pager, createOffsetPages } from '~/components/pager';
import { SettingsSection } from '~/components/settings/settings-section';
import {
  DisabledBadge,
  EmptyState,
  ErrorState,
  FilterChips,
  OriginBadge,
  RowLink,
  SearchInput,
} from '~/components/store/store-list';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { Cable, ChevronRight, Plus, Upload } from '~/components/icons';
import { createSearchDraft } from './store-filters';

export const EXTERNAL_SERVICE_FILTERS = ['all', 'built_in', 'custom', 'needs_setup'] as const;

export type ExternalServiceFilter = (typeof EXTERNAL_SERVICE_FILTERS)[number];

export interface ExternalServicesListSearch {
  filter: ExternalServiceFilter;
  q: string;
}

export function validateExternalServicesSearch(
  search: Record<string, unknown> & SearchSchemaInput
): ExternalServicesListSearch {
  const filter = EXTERNAL_SERVICE_FILTERS.find((candidate) => candidate === search.filter);
  return { filter: filter ?? 'all', q: typeof search.q === 'string' ? search.q : '' };
}

const FILTER_OPTIONS: { id: ExternalServiceFilter; label: string; operatorsOnly?: boolean }[] = [
  { id: 'all', label: 'All' },
  { id: 'built_in', label: 'Built-in' },
  { id: 'custom', label: 'Custom' },
  { id: 'needs_setup', label: 'Needs setup', operatorsOnly: true },
];

interface ServiceRow extends ExternalServiceSummary {
  needsSetup: boolean;
  viewOnly: boolean;
  disabled: boolean;
  hidesBuiltIn: boolean;
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
    href: `/store/external-services/${service.id}`,
    ...state,
  };
}

function matchesQuery(row: ServiceRow, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return row.displayName.toLowerCase().includes(needle) || row.slug.includes(needle);
}

function matchesFilter(row: ServiceRow, filter: ExternalServiceFilter): boolean {
  if (filter === 'built_in' || filter === 'custom') return row.origin === filter;
  if (filter === 'needs_setup') return row.needsSetup;
  return true;
}

export function ExternalServicesListPage(props: {
  filter: ExternalServiceFilter;
  query: string;
  onFilter: (filter: ExternalServiceFilter) => void;
  onQuery: (query: string) => void;
}) {
  const { permissions, hasPermission } = usePermissions();
  const isOperator = () => canManageExternalService('built_in', hasPermission);
  const isTenantAdmin = () => canManageExternalService('custom', hasPermission);
  const operatorServices = useOperatorServices(isOperator);
  const tenantServices = useTenantServices(isTenantAdmin);
  const search = createSearchDraft(
    () => props.query,
    (query) => props.onQuery(query)
  );
  const filter = () => (props.filter === 'needs_setup' && !isOperator() ? 'all' : props.filter);

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
    return rows.toSorted((a, b) => a.displayName.localeCompare(b.displayName));
  });

  const rows = createMemo(() =>
    allRows().filter((row) => matchesFilter(row, filter()) && matchesQuery(row, props.query))
  );
  const pages = createOffsetPages(rows);
  createEffect(on([filter, () => props.query], () => pages.toFirst(), { defer: true }));

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
        <div class="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
          <SearchInput value={search.draft()} onInput={search.onInput} label="Search External Services" />
          <FilterChips
            label="Filter External Services"
            options={FILTER_OPTIONS.filter((option) => isOperator() || !option.operatorsOnly)}
            value={filter()}
            onChange={props.onFilter}
          />
        </div>

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
              <div class="overflow-hidden rounded-xl border border-border bg-card">
                <div class="divide-y divide-border">
                  <For each={pages.page()}>{(row) => <ServiceListRow row={row} />}</For>
                </div>
                <Show when={pages.needsPager()}>
                  <Pager {...pages.pagerProps()} />
                </Show>
              </div>
            </Show>
          </Show>
        </Show>
      </Show>

      <NewExternalServiceDialog open={createOpen()} onOpenChange={setCreateOpen} />
      <ImportServiceDialog open={importOpen()} onOpenChange={setImportOpen} />
    </SettingsSection>
  );
}

function ServiceListRow(props: { row: ServiceRow }) {
  return (
    <RowLink href={props.row.href} class="p-4">
      <ServiceIcon icon={props.row.icon} name={props.row.displayName} class="h-4 w-4" />
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span class="text-sm font-medium">{props.row.displayName}</span>
          <span class="font-mono text-[11px] text-muted-foreground">{props.row.slug}</span>
          <OriginBadge origin={props.row.origin} />
          <Show when={props.row.disabled}>
            <DisabledBadge />
          </Show>
          <Show when={props.row.needsSetup}>
            <NeedsSetupBadge />
          </Show>
        </div>
        <div class="mt-0.5 truncate text-xs text-muted-foreground">{props.row.description}</div>
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
