import { Dialog as Kobalte } from '@kobalte/core/dialog';
import { For, Show, createEffect, createSignal, on, type JSX } from 'solid-js';
import { ApiError } from '~/api/client';
import {
  RECORDS_BUSY,
  RECORDS_UNREADABLE,
  useCallLogPage,
  type CallLogEntry,
  type CallLogOutcome,
  type CallLogOutcomeFilter,
  type CallLogTimeRange,
} from '~/api/external-service-call-log';
import { ChartColumn, Copy, RefreshCw, X } from '~/components/icons';
import { Pager, createCursorPages } from '~/components/pager';
import { EmptyState, ErrorState, FilterChips } from '~/components/store/store-list';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';
import { cn } from '~/lib/cn';
import { formatBytes } from '~/lib/format-bytes';
import { formatDateTime } from '~/lib/format-date';

type Choice<T extends string> = 'all' | T;

const OUTCOME_FILTERS: { id: Choice<CallLogOutcomeFilter>; label: string }[] = [
  { id: 'all', label: 'All outcomes' },
  { id: 'allowed', label: 'Allowed' },
  { id: 'not allowed', label: 'Not allowed' },
  { id: 'not supported', label: 'Not supported' },
  { id: 'failed', label: 'Failed' },
];

const TIME_FILTERS: { id: CallLogTimeRange; label: string }[] = [
  { id: '1h', label: '1 h' },
  { id: '24h', label: '24 h' },
  { id: '7d', label: '7 d' },
  { id: '30d', label: '30 d' },
];

const OUTCOME_LABELS: Record<CallLogOutcome, string> = {
  proxied: 'Allowed',
  handled: 'Allowed',
  'not supported': 'Not supported',
  'not allowed': 'Not allowed',
  failed: 'Failed',
};

const OUTCOME_CHIP: Record<CallLogOutcome, string> = {
  proxied: 'bg-emerald-50 text-emerald-700',
  handled: 'bg-emerald-50 text-emerald-700',
  'not supported': 'bg-muted text-muted-foreground',
  'not allowed': 'bg-red-50 text-red-700',
  failed: 'bg-amber-50 text-amber-700',
};

const REQUEST_LENGTH = 40;

function middleTruncated(text: string, length = REQUEST_LENGTH): string {
  if (text.length <= length) return text;
  const kept = length - 1;
  return `${text.slice(0, Math.ceil(kept / 2))}…${text.slice(text.length - Math.floor(kept / 2))}`;
}

const PLATFORM_ACTIVITIES: [prefix: string, activity: string][] = [
  ['options.', 'Loading form choices'],
  ['info.', 'Loading form details'],
  ['buttons.', 'Form button'],
  ['hooks.onServiceConfigurationSaved', 'Applying the Service configuration'],
  ['hooks.onProjectConfigurationSaved', 'Applying the Project configuration'],
];

function platformActivity(call: CallLogEntry): string {
  return PLATFORM_ACTIVITIES.find(([prefix]) => call.route?.startsWith(prefix))?.[1] ?? 'Platform check';
}

function callerText(call: CallLogEntry): string {
  if (call.callerKind === 'platform' && !call.projectId) return platformActivity(call);
  const project = call.projectId ? call.projectTitle?.trim() || 'Deleted project' : 'No Project';
  const place = call.environmentName ?? call.environment;
  const named = place ? `${project} · ${place}` : project;
  return call.callerKind === 'platform' ? `${named} · ${platformActivity(call)}` : named;
}

const ANSWERED_BY: Partial<Record<CallLogOutcome, string>> = {
  proxied: 'The upstream',
  handled: 'The service itself',
};

function durationText(durationMs: number): string {
  return durationMs < 1000 ? `${durationMs} ms` : `${(durationMs / 1000).toFixed(1)} s`;
}

function OutcomeChip(props: { outcome: CallLogOutcome }) {
  return (
    <span class={cn('whitespace-nowrap rounded px-1.5 py-px text-[10px] font-medium', OUTCOME_CHIP[props.outcome])}>
      {OUTCOME_LABELS[props.outcome]}
    </span>
  );
}

export function recordsError(error: unknown, fallback: string): { busy: boolean; message: string } {
  if (error instanceof ApiError && error.code === RECORDS_BUSY) {
    return { busy: true, message: "The service's records are busy. Reload to try again." };
  }
  if (error instanceof ApiError && error.code === RECORDS_UNREADABLE) {
    const podState = typeof error.details.podState === 'string' ? error.details.podState : null;
    return {
      busy: false,
      message: `The service's records can't be read${podState ? ` (its pod is ${podState})` : ''}.`,
    };
  }
  return { busy: false, message: fallback };
}

export function CallLog(props: { source: string; showProject?: boolean; compact?: boolean; toolbar?: JSX.Element }) {
  const [outcome, setOutcome] = createSignal<Choice<CallLogOutcomeFilter>>('all');
  const [projectId, setProjectId] = createSignal<string>('all');
  const [since, setSince] = createSignal<CallLogTimeRange>('30d');
  const [opened, setOpened] = createSignal<CallLogEntry | null>(null);
  const pages = createCursorPages();

  createEffect(on([outcome, projectId, since, () => props.source], () => pages.toFirst(), { defer: true }));

  const page = useCallLogPage(
    () => props.source,
    () => ({
      cursor: pages.cursor(),
      outcome: outcome() === 'all' ? null : (outcome() as CallLogOutcomeFilter),
      projectId: props.showProject && projectId() !== 'all' ? projectId() : null,
      since: since() === '30d' ? null : since(),
    })
  );
  const calls = () => page.data?.calls ?? [];
  const projectFilters = () => [
    { id: 'all', label: 'All Projects' },
    ...(page.data?.projects ?? []).map((project) => ({
      id: project.projectId,
      label: project.title?.trim() || 'Deleted project',
    })),
  ];
  const filtered = () => outcome() !== 'all' || projectId() !== 'all' || since() !== '30d';
  const error = () => recordsError(page.error, 'The Calls could not be loaded.');

  return (
    <div class="flex flex-col gap-3">
      <div class="flex flex-wrap items-center gap-2">
        {props.toolbar}
        <FilterChips label="Time range" options={TIME_FILTERS} value={since()} onChange={setSince} />
        <Button
          size="sm"
          variant="outline"
          class="ml-auto h-7 px-2.5 text-xs"
          disabled={page.isFetching}
          onClick={() => void page.refetch()}
        >
          <RefreshCw class={cn('h-3.5 w-3.5', page.isFetching && 'animate-spin')} aria-hidden="true" />
          Refresh
        </Button>
      </div>
      <div class={cn('flex flex-col gap-2', !props.compact && 'lg:flex-row lg:flex-wrap lg:items-center')}>
        <FilterChips label="Outcome" options={OUTCOME_FILTERS} value={outcome()} onChange={setOutcome} />
        <Show when={props.showProject && projectFilters().length > 1}>
          <FilterChips label="Project" options={projectFilters()} value={projectId()} onChange={setProjectId} />
        </Show>
      </div>
      <Show
        when={!page.isError}
        fallback={
          <div class="flex flex-col items-center gap-3">
            <ErrorState message={error().message} />
            <Show when={error().busy}>
              <Button size="sm" variant="outline" onClick={() => void page.refetch()}>
                <RefreshCw class="h-3.5 w-3.5" aria-hidden="true" />
                Reload
              </Button>
            </Show>
          </div>
        }
      >
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
                title={filtered() ? 'No calls match.' : `No calls in the last ${page.data?.retentionDays ?? 30} days`}
              />
            }
          >
            <div class="overflow-hidden rounded-lg border border-border bg-card">
              <div class="overflow-x-auto">
                <Table layout="responsive">
                  <TableHeader>
                    <TableRow>
                      <TableHead class="w-36">Time</TableHead>
                      <Show when={props.showProject}>
                        <TableHead>Caller</TableHead>
                      </Show>
                      <TableHead>Request</TableHead>
                      <TableHead>Outcome</TableHead>
                      <TableHead class="w-14 text-right">Status</TableHead>
                      <Show when={!props.compact}>
                        <TableHead class="w-20 text-right">Duration</TableHead>
                        <TableHead class="w-32 text-right">Size in → out</TableHead>
                      </Show>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    <For each={calls()}>
                      {(call) => (
                        <TableRow
                          class="cursor-pointer"
                          tabindex="0"
                          aria-label={`Call ${call.method} ${call.path}`}
                          onClick={() => setOpened(call)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              setOpened(call);
                            }
                          }}
                        >
                          <TableCell class="whitespace-nowrap font-mono text-[11px] tabular-nums text-muted-foreground">
                            {formatDateTime(call.time)}
                          </TableCell>
                          <Show when={props.showProject}>
                            <TableCell
                              label="Caller"
                              class="max-w-40 truncate whitespace-nowrap text-xs"
                              title={callerText(call)}
                            >
                              {callerText(call)}
                            </TableCell>
                          </Show>
                          <TableCell
                            label="Request"
                            class="whitespace-nowrap font-mono text-[11px]"
                            title={`${call.method} ${call.path}`}
                          >
                            <span>
                              <span class="mr-1.5 text-muted-foreground">{call.method}</span>
                              {middleTruncated(call.path, props.compact ? 32 : REQUEST_LENGTH)}
                            </span>
                          </TableCell>
                          <TableCell label="Outcome" class="max-w-56 text-xs">
                            <div>
                              <OutcomeChip outcome={call.outcome} />
                              <Show when={call.reason}>
                                {(reason) => (
                                  <div class="mt-0.5 truncate text-[11px] text-muted-foreground" title={reason()}>
                                    {reason()}
                                  </div>
                                )}
                              </Show>
                            </div>
                          </TableCell>
                          <TableCell
                            label="Status"
                            class={cn(
                              'text-right font-mono text-[11px] tabular-nums',
                              call.status >= 400 && 'text-red-700'
                            )}
                          >
                            {call.status}
                          </TableCell>
                          <Show when={!props.compact}>
                            <TableCell label="Duration" class="text-right font-mono text-[11px] tabular-nums">
                              {durationText(call.durationMs)}
                            </TableCell>
                            <TableCell
                              label="Size in → out"
                              class="whitespace-nowrap text-right font-mono text-[11px] tabular-nums"
                            >
                              {formatBytes(call.bytesIn)} → {formatBytes(call.bytesOut)}
                            </TableCell>
                          </Show>
                        </TableRow>
                      )}
                    </For>
                  </TableBody>
                </Table>
              </div>
              <Pager
                {...pages.pagerProps(page.data, calls().length)}
                note={`newest first · kept ${page.data?.retentionDays ?? 30} days`}
              />
            </div>
          </Show>
        </Show>
      </Show>
      <CallSidePanel call={opened()} onClose={() => setOpened(null)} />
    </div>
  );
}

function Detail(props: { label: string; children: JSX.Element }) {
  return (
    <div class="flex flex-col gap-1">
      <dt class="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{props.label}</dt>
      <dd class="text-sm text-foreground">{props.children}</dd>
    </div>
  );
}

function CallSidePanel(props: { call: CallLogEntry | null; onClose: () => void }) {
  return (
    <Kobalte open={props.call !== null} onOpenChange={(open) => !open && props.onClose()}>
      <Kobalte.Portal>
        <Kobalte.Overlay class="fixed inset-0 z-50 bg-black/30" />
        <Show when={props.call}>
          {(call) => (
            <Kobalte.Content class="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col overflow-y-auto border-l border-border bg-popover p-6 shadow-lg">
              <div class="mb-4 flex items-start gap-2">
                <div class="min-w-0 flex-1">
                  <Kobalte.Title class="break-all font-mono text-sm font-medium">
                    {call().method} {call().path}
                  </Kobalte.Title>
                  <Kobalte.Description class="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                    <OutcomeChip outcome={call().outcome} />
                    {call().status} · {durationText(call().durationMs)}
                  </Kobalte.Description>
                </div>
                <Kobalte.CloseButton
                  class="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                  aria-label="Close"
                >
                  <X class="h-4 w-4" />
                </Kobalte.CloseButton>
              </div>
              <dl class="flex flex-col gap-4">
                <Show when={call().reason}>
                  {(reason) => (
                    <Detail label="Reason">
                      <span class="whitespace-pre-wrap break-words">{reason()}</span>
                    </Detail>
                  )}
                </Show>
                <Detail label="Caller">{callerText(call())}</Detail>
                <Show when={ANSWERED_BY[call().outcome]}>
                  {(answeredBy) => <Detail label="Answered by">{answeredBy()}</Detail>}
                </Show>
                <Detail label="Route">{call().route ?? '—'}</Detail>
                <Detail label="Time">
                  <span class="font-mono text-xs">{call().time}</span>
                </Detail>
                <Detail label="Size in → out">
                  {formatBytes(call().bytesIn)} → {formatBytes(call().bytesOut)}
                </Detail>
                <Detail label="Request id">
                  <span class="inline-flex items-center gap-1.5">
                    <span class="break-all font-mono text-xs">{call().requestId}</span>
                    <button
                      type="button"
                      class="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                      aria-label="Copy request id"
                      onClick={() => void navigator.clipboard?.writeText(call().requestId)}
                    >
                      <Copy class="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </span>
                </Detail>
                <Show when={Object.keys(call().notes).length > 0}>
                  <Detail label="Service's fields">
                    <pre class="overflow-x-auto rounded-md bg-muted p-2 font-mono text-[11px]">
                      {JSON.stringify(call().notes, null, 2)}
                    </pre>
                  </Detail>
                </Show>
              </dl>
            </Kobalte.Content>
          )}
        </Show>
      </Kobalte.Portal>
    </Kobalte>
  );
}
