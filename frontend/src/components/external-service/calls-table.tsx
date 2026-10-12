import { For, Show, createEffect, createSignal, on, onCleanup } from 'solid-js';
import { useCallPage, type CallOutcome, type ServiceCall, type TouchedBound } from '~/api/external-service-calls';
import { ChartColumn } from '~/components/icons';
import { Pager, createCursorPages } from '~/components/pager';
import { EmptyState, ErrorState, FilterChips, SearchInput } from '~/components/store/store-list';
import { Spinner } from '~/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';
import { cn } from '~/lib/cn';
import { formatDateTime } from '~/lib/format-date';

export type CallsScope = 'environment' | 'tenant' | 'platform';

type OutcomeFilter = 'all' | CallOutcome;

const OUTCOME_FILTERS: { id: OutcomeFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'allowed', label: 'Allowed' },
  { id: 'refused', label: 'Refused' },
  { id: 'failed', label: 'Failed' },
];

const OUTCOME_PILL: Record<CallOutcome, string> = {
  allowed: 'bg-emerald-50 text-emerald-700',
  refused: 'bg-red-50 text-red-700',
  failed: 'bg-amber-50 text-amber-700',
};

const SEARCH_DELAY_MS = 300;

function boundText(bound: TouchedBound): string {
  if (bound.label) return bound.label;
  return typeof bound.value === 'string' ? bound.value : JSON.stringify(bound.value);
}

function boundValues(call: ServiceCall): string {
  return call.bounds && call.bounds.length > 0 ? call.bounds.map(boundText).join(', ') : '—';
}

function callOrigin(call: ServiceCall, scope: CallsScope): string {
  if (!call.projectId && !call.projectTitle) {
    return call.kind === 'inbound' ? `${call.slug} webhook` : 'No Project';
  }
  const project = call.projectTitle?.trim() || 'Untitled project';
  const place = call.environmentName ? `${project} · ${call.environmentName}` : project;
  return scope === 'platform' && call.tenantName ? `${call.tenantName} · ${place}` : place;
}

function resultText(call: ServiceCall): string {
  return call.code ? `${call.status} ${call.code}` : String(call.status);
}

export function CallsTable(props: { source: string; scope: CallsScope; compact?: boolean; showService?: boolean }) {
  const [searchInput, setSearchInput] = createSignal('');
  const [search, setSearch] = createSignal('');
  const [outcome, setOutcome] = createSignal<OutcomeFilter>('all');
  const pages = createCursorPages();

  createEffect(
    on(
      searchInput,
      (value) => {
        const timer = setTimeout(() => setSearch(value.trim()), SEARCH_DELAY_MS);
        onCleanup(() => clearTimeout(timer));
      },
      { defer: true }
    )
  );
  createEffect(on([search, outcome, () => props.source], () => pages.toFirst(), { defer: true }));

  const page = useCallPage(
    () => props.source,
    () => ({
      cursor: pages.cursor(),
      search: search(),
      outcome: outcome() === 'all' ? null : (outcome() as CallOutcome),
    })
  );
  const calls = () => page.data?.calls ?? [];
  const showOrigin = () => props.scope !== 'environment';
  const filtered = () => search() !== '' || outcome() !== 'all';
  const kept = () => {
    const days = page.data?.retentionDays;
    return days === undefined ? '' : `kept ${days} ${days === 1 ? 'day' : 'days'}`;
  };

  return (
    <div class="flex flex-col gap-3">
      <div class={cn('flex flex-col gap-3', !props.compact && 'sm:flex-row sm:items-center')}>
        <SearchInput value={searchInput()} onInput={setSearchInput} label="Search operation or bound value" />
        <FilterChips label="Filter calls" options={OUTCOME_FILTERS} value={outcome()} onChange={setOutcome} />
      </div>
      <Show when={!page.isError} fallback={<ErrorState message="The Calls could not be loaded." />}>
        <Show
          when={page.data}
          fallback={
            <div class="flex justify-center py-6">
              <Spinner />
            </div>
          }
        >
          <Show
            when={calls().length > 0}
            fallback={
              <EmptyState
                icon={ChartColumn}
                title={filtered() ? 'No calls match.' : 'No calls yet.'}
                hint={`Calls are ${kept()}.`}
              />
            }
          >
            <div class="overflow-hidden rounded-lg border border-border bg-card">
              <div class="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead class="w-36">Time</TableHead>
                      <Show when={showOrigin()}>
                        <TableHead>From</TableHead>
                      </Show>
                      <TableHead>Call</TableHead>
                      <TableHead>Result</TableHead>
                      <TableHead class="w-16 text-right">ms</TableHead>
                      <Show when={!props.compact}>
                        <TableHead>Bound values</TableHead>
                      </Show>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    <For each={calls()}>
                      {(call) => (
                        <TableRow>
                          <TableCell class="whitespace-nowrap font-mono text-[11px] tabular-nums text-muted-foreground">
                            {formatDateTime(call.createdAt)}
                          </TableCell>
                          <Show when={showOrigin()}>
                            <TableCell class="text-xs">{callOrigin(call, props.scope)}</TableCell>
                          </Show>
                          <TableCell class="whitespace-nowrap text-xs">
                            <Show when={props.showService}>
                              <span class="mr-1.5 text-[11px] text-muted-foreground">{call.slug}</span>
                            </Show>
                            <span class="font-mono text-[11px]">{call.operation ?? '—'}</span>
                            <span class="ml-1.5 text-[11px] text-muted-foreground">
                              {call.kind}
                              {call.via ? ` · ${call.via}` : ''}
                            </span>
                            <Show when={call.servedBy}>
                              {(servedBy) => (
                                <div class="text-[11px] text-muted-foreground">Served by {servedBy()}</div>
                              )}
                            </Show>
                          </TableCell>
                          <TableCell>
                            <span
                              class={cn(
                                'whitespace-nowrap rounded px-1.5 py-px text-[10px] font-medium',
                                OUTCOME_PILL[call.outcome]
                              )}
                              title={call.detail ?? undefined}
                            >
                              {resultText(call)}
                            </span>
                          </TableCell>
                          <TableCell class="text-right font-mono text-[11px] tabular-nums">{call.durationMs}</TableCell>
                          <Show when={!props.compact}>
                            <TableCell class="text-xs">{boundValues(call)}</TableCell>
                          </Show>
                        </TableRow>
                      )}
                    </For>
                  </TableBody>
                </Table>
              </div>
              <Pager {...pages.pagerProps(page.data, calls().length)} note={`newest first · ${kept()}`} />
            </div>
          </Show>
        </Show>
      </Show>
    </div>
  );
}
