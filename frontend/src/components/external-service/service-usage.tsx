import { For, Show, createEffect, createSignal, on } from 'solid-js';
import type { ServiceCopy } from '~/api/external-service-call-log';
import {
  useServiceUsage,
  type UsageCounter,
  type UsageEnvironment,
  type UsageProject,
  type UsageValues,
} from '~/api/external-service-usage';
import { recordsError } from '~/components/external-service/call-log';
import { ChartColumn, ChevronRight, RefreshCw } from '~/components/icons';
import { EmptyState, ErrorState, FilterChips } from '~/components/store/store-list';
import { Button } from '~/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select';
import { Spinner } from '~/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '~/components/ui/tooltip';
import { cn } from '~/lib/cn';

const COPY_OPTIONS: { id: ServiceCopy; label: string }[] = [
  { id: 'default', label: 'Default' },
  { id: 'development', label: 'Development' },
];

function formatMonth(month: string): string {
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function projectLabel(project: UsageProject): string {
  if (project.deleted) return 'Deleted project';
  return project.title?.trim() || 'Untitled project';
}

function projectKey(project: UsageProject): string {
  return project.projectId ?? 'deleted';
}

function CounterHead(props: { counter: UsageCounter }) {
  return (
    <TableHead class="whitespace-nowrap text-right">
      <Show when={props.counter.description} fallback={props.counter.label}>
        {(description) => (
          <Tooltip>
            <TooltipTrigger as="span" class="cursor-help underline decoration-dotted underline-offset-4">
              {props.counter.label}
            </TooltipTrigger>
            <TooltipContent>{description()}</TooltipContent>
          </Tooltip>
        )}
      </Show>
    </TableHead>
  );
}

function CountCells(props: { counters: UsageCounter[]; values: UsageValues; strong?: boolean }) {
  return (
    <For each={props.counters}>
      {(counter) => {
        const value = () => props.values[counter.name] ?? 0;
        return (
          <TableCell
            label={counter.label}
            class={cn(
              'text-right font-mono text-xs tabular-nums',
              value() === 0 && 'text-muted-foreground/60',
              props.strong && 'font-semibold'
            )}
          >
            {value().toLocaleString()}
          </TableCell>
        );
      }}
    </For>
  );
}

function EnvironmentRow(props: { environment: UsageEnvironment; counters: UsageCounter[] }) {
  return (
    <TableRow class="bg-muted/20">
      <TableCell class="pl-10 text-xs text-muted-foreground">
        {props.environment.environmentName ?? 'Deleted environment'}
      </TableCell>
      <CountCells counters={props.counters} values={props.environment.values} />
    </TableRow>
  );
}

function ProjectRows(props: {
  project: UsageProject;
  counters: UsageCounter[];
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <TableRow
        class="cursor-pointer"
        tabindex="0"
        aria-expanded={props.expanded}
        onClick={() => props.onToggle()}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            props.onToggle();
          }
        }}
      >
        <TableCell class="text-sm">
          <span class="inline-flex items-center gap-1.5">
            <ChevronRight
              class={cn(
                'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
                props.expanded && 'rotate-90'
              )}
              aria-hidden="true"
            />
            <span class={cn(props.project.deleted && 'italic text-muted-foreground')}>
              {projectLabel(props.project)}
            </span>
          </span>
        </TableCell>
        <CountCells counters={props.counters} values={props.project.values} />
      </TableRow>
      <Show when={props.expanded}>
        <For each={props.project.environments}>
          {(environment) => <EnvironmentRow environment={environment} counters={props.counters} />}
        </For>
      </Show>
    </>
  );
}

export function ServiceUsage(props: { serviceId: string; showCopy: boolean }) {
  const [copy, setCopy] = createSignal<ServiceCopy>('default');
  const [month, setMonth] = createSignal<string | null>(null);
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set());

  createEffect(on(copy, () => setMonth(null), { defer: true }));

  const usage = useServiceUsage(() => props.serviceId, copy, month);
  const view = () => usage.data;
  const error = () => recordsError(usage.error, 'The Usage could not be loaded.');
  const toggle = (key: string) =>
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div class="flex flex-col gap-3">
      <div class="flex flex-wrap items-center gap-2">
        <Show when={props.showCopy}>
          <FilterChips label="Copy of the service" options={COPY_OPTIONS} value={copy()} onChange={setCopy} />
        </Show>
        <Show when={(view()?.months.length ?? 0) > 0 && view()?.month}>
          {(shown) => (
            <Select
              options={view()?.months ?? []}
              value={shown()}
              onChange={(value) => value && setMonth(value)}
              itemComponent={(itemProps) => (
                <SelectItem item={itemProps.item}>{formatMonth(itemProps.item.rawValue)}</SelectItem>
              )}
            >
              <SelectTrigger class="h-7 w-44 text-xs" aria-label="Month">
                <SelectValue<string>>{(state) => formatMonth(state.selectedOption())}</SelectValue>
              </SelectTrigger>
              <SelectContent />
            </Select>
          )}
        </Show>
        <Button
          size="sm"
          variant="outline"
          class="ml-auto h-7 px-2.5 text-xs"
          disabled={usage.isFetching}
          onClick={() => void usage.refetch()}
        >
          <RefreshCw class={cn('h-3.5 w-3.5', usage.isFetching && 'animate-spin')} aria-hidden="true" />
          Refresh
        </Button>
      </div>
      <Show
        when={!usage.isError}
        fallback={
          <div class="flex flex-col items-center gap-3">
            <ErrorState message={error().message} />
            <Show when={error().busy}>
              <Button size="sm" variant="outline" onClick={() => void usage.refetch()}>
                <RefreshCw class="h-3.5 w-3.5" aria-hidden="true" />
                Reload
              </Button>
            </Show>
          </div>
        }
      >
        <Show
          when={view()}
          fallback={
            <div class="flex justify-center py-6">
              <Spinner />
            </div>
          }
        >
          {(shown) => (
            <Show
              when={shown().projects.length > 0 || shown().service !== null}
              fallback={
                <EmptyState
                  icon={ChartColumn}
                  title={shown().month ? `No usage in ${formatMonth(shown().month ?? '')}` : 'No usage counted yet'}
                  hint="Counts fill as Projects call the service and as it counts what it does."
                />
              }
            >
              <div class="overflow-hidden rounded-lg border border-border bg-card">
                <div class="overflow-x-auto">
                  <Table layout="responsive">
                    <TableHeader>
                      <TableRow>
                        <TableHead class="min-w-56">Project · environment</TableHead>
                        <For each={shown().counters}>{(counter) => <CounterHead counter={counter} />}</For>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      <For each={shown().projects}>
                        {(project) => (
                          <ProjectRows
                            project={project}
                            counters={shown().counters}
                            expanded={expanded().has(projectKey(project))}
                            onToggle={() => toggle(projectKey(project))}
                          />
                        )}
                      </For>
                      <Show when={shown().service}>
                        {(values) => (
                          <TableRow>
                            <TableCell class="text-sm" title="Counted by the service outside any Project's request">
                              Service
                            </TableCell>
                            <CountCells counters={shown().counters} values={values()} />
                          </TableRow>
                        )}
                      </Show>
                      <TableRow class="border-t-2 border-border hover:bg-transparent">
                        <TableCell class="text-sm font-semibold">Total</TableCell>
                        <CountCells counters={shown().counters} values={shown().totals} strong />
                      </TableRow>
                    </TableBody>
                  </Table>
                </div>
              </div>
            </Show>
          )}
        </Show>
      </Show>
    </div>
  );
}
