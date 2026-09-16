import { createMemo, createSignal, For, Show } from 'solid-js';
import {
  useExternalServicesUsage,
  type UsageProjectBreakdown,
  type UsageServiceBreakdown,
} from '~/api/external-services-usage';
import { cn } from '~/lib/cn';
import { Badge } from '~/components/ui/badge';
import { Skeleton } from '~/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';
import { ChartColumn, ChevronRight, FolderKanban, Inbox, RefreshCw } from '~/components/icons';

const COLUMN_COUNT = 3;
const MONTH_OPTION_COUNT = 12;

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

function monthOptions(): string[] {
  const now = new Date();
  return Array.from({ length: MONTH_OPTION_COUNT }, (_, offset) =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1)).toISOString().slice(0, 7)
  );
}

function formatMonth(month: string): string {
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function formatCount(count: number): string {
  return count.toLocaleString();
}

function projectLabel(project: UsageProjectBreakdown): string {
  if (project.deleted) return 'Project (deleted)';
  return project.projectTitle?.trim() || 'Untitled project';
}

export function ExternalServicesUsagePage() {
  const [month, setMonth] = createSignal(currentMonth());
  const usage = useExternalServicesUsage(month);

  const services = createMemo(() => usage.data?.services ?? []);
  const total = createMemo(() => services().reduce((sum, service) => sum + service.count, 0));

  const [expanded, setExpanded] = createSignal<Set<string>>(new Set());
  const toggleService = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div class="w-full overflow-y-auto h-full px-4 py-6">
      <div class="flex items-center gap-3 mb-1">
        <ChartColumn class="w-5 h-5 text-muted-foreground" />
        <h1 class="text-xl font-semibold">Usage</h1>
        <Show when={!usage.isPending}>
          <Badge variant="secondary" class="text-[10px] px-1.5 py-0">
            {formatCount(total())}
          </Badge>
        </Show>
        <div class="ml-auto flex items-center gap-2">
          <Select
            options={monthOptions()}
            value={month()}
            onChange={(value) => value && setMonth(value)}
            itemComponent={(itemProps) => (
              <SelectItem item={itemProps.item}>{formatMonth(itemProps.item.rawValue)}</SelectItem>
            )}
          >
            <SelectTrigger class="w-40" aria-label="Month">
              <SelectValue<string>>{(state) => formatMonth(state.selectedOption())}</SelectValue>
            </SelectTrigger>
            <SelectContent />
          </Select>
          <button
            type="button"
            onClick={() => usage.refetch()}
            class="inline-flex items-center justify-center rounded-md w-7 h-7 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            aria-label="Refresh usage"
          >
            <RefreshCw class={cn('w-3.5 h-3.5', usage.isFetching && 'animate-spin')} />
          </button>
        </div>
      </div>

      <p class="text-xs text-muted-foreground mb-5 ml-8">
        Inbound external-service messages stored in {formatMonth(month())} for your organization, per service. Counts
        survive project and environment deletion.
      </p>

      <Show when={usage.isPending}>
        <LoadingState />
      </Show>

      <Show when={!usage.isPending && usage.isError}>
        <ErrorState onRetry={() => usage.refetch()} />
      </Show>

      <Show when={!usage.isPending && !usage.isError && services().length === 0}>
        <EmptyState month={month()} />
      </Show>

      <Show when={!usage.isPending && !usage.isError && services().length > 0}>
        <div class="rounded-lg border border-border overflow-hidden bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead class="min-w-64">Service</TableHead>
                <TableHead class="w-32 text-right">Messages</TableHead>
                <TableHead class="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              <For each={services()}>
                {(service) => (
                  <ServiceRow
                    service={service}
                    expanded={expanded().has(service.service)}
                    onToggle={() => toggleService(service.service)}
                  />
                )}
              </For>
            </TableBody>
          </Table>
        </div>
      </Show>
    </div>
  );
}

function ServiceRow(props: { service: UsageServiceBreakdown; expanded: boolean; onToggle: () => void }) {
  return (
    <>
      <TableRow class="cursor-pointer" onClick={props.onToggle}>
        <TableCell>
          <div class="font-medium text-sm">{props.service.displayName}</div>
          <span class="font-mono text-[11px] text-muted-foreground">{props.service.service}</span>
        </TableCell>
        <TableCell class="text-right text-sm tabular-nums">{formatCount(props.service.count)}</TableCell>
        <TableCell class="text-right pr-3">
          <ChevronRight
            class={cn('w-4 h-4 inline text-muted-foreground transition-transform', props.expanded && 'rotate-90')}
          />
        </TableCell>
      </TableRow>

      <Show when={props.expanded}>
        <TableRow class="hover:bg-transparent">
          <TableCell colspan={COLUMN_COUNT} class="bg-muted/30">
            <div class="flex flex-col gap-3 py-1 pl-4">
              <For each={props.service.projects}>{(project) => <ProjectBreakdown project={project} />}</For>
            </div>
          </TableCell>
        </TableRow>
      </Show>
    </>
  );
}

function ProjectBreakdown(props: { project: UsageProjectBreakdown }) {
  return (
    <div class="min-w-0">
      <div class="flex items-center gap-2">
        <FolderKanban class="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
        <span class={cn('text-xs font-medium truncate', props.project.deleted && 'text-muted-foreground italic')}>
          {projectLabel(props.project)}
        </span>
        <span class="ml-auto text-xs tabular-nums text-muted-foreground shrink-0">
          {formatCount(props.project.count)}
        </span>
      </div>
      <div class="mt-1 flex flex-col gap-0.5 pl-5">
        <For each={props.project.environments}>
          {(environment) => (
            <div class="flex items-center gap-2">
              <span
                class={cn('text-xs truncate', environment.deleted ? 'text-muted-foreground italic' : 'text-foreground')}
              >
                {environment.deleted ? 'Environment (deleted)' : environment.environmentName}
              </span>
              <span class="ml-auto text-xs tabular-nums text-muted-foreground shrink-0">
                {formatCount(environment.count)}
              </span>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}

function LoadingState() {
  return (
    <div class="rounded-lg border border-border bg-card p-4 flex flex-col gap-3">
      <For each={[0, 1, 2, 3]}>{() => <Skeleton class="h-8 w-full" />}</For>
    </div>
  );
}

function ErrorState(props: { onRetry: () => void }) {
  return (
    <div class="rounded-lg border border-border bg-card p-8 flex flex-col items-center gap-3 text-center">
      <p class="text-sm text-muted-foreground">Could not load usage.</p>
      <button
        type="button"
        onClick={() => props.onRetry()}
        class="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent transition-colors"
      >
        <RefreshCw class="w-3.5 h-3.5" />
        Try again
      </button>
    </div>
  );
}

function EmptyState(props: { month: string }) {
  return (
    <div class="rounded-lg border border-border bg-card p-8 flex flex-col items-center gap-2 text-center">
      <Inbox class="w-6 h-6 text-muted-foreground" />
      <p class="text-sm font-medium">No inbound messages in {formatMonth(props.month)}</p>
      <p class="text-xs text-muted-foreground">
        Counters start filling as soon as an external service stores a message for an environment.
      </p>
    </div>
  );
}
