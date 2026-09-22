import { createMemo, createSignal, For, Show, type JSX } from 'solid-js';
import { Link } from '@tanstack/solid-router';
import { usePods, type PodRow } from '~/api/pods';
import { elapsedSince, useNow } from '~/lib/use-now';
import { formatAgo, formatClock, formatDuration } from '~/lib/format-duration';
import { formatCores, formatGib } from '~/lib/pod-resources';
import { cn } from '~/lib/cn';
import { Badge } from '~/components/ui/badge';
import { Skeleton } from '~/components/ui/skeleton';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '~/components/ui/table';
import { Tooltip, TooltipTrigger, TooltipContent } from '~/components/ui/tooltip';
import { KeepAliveCell } from '~/components/pods/keep-alive-cell';
import { PodStatusCell } from '~/components/pods/pod-status-cell';
import { AlertTriangle, Boxes, ChevronRight, ExternalLink, FolderKanban, RefreshCw } from '~/components/icons';

const COLUMN_COUNT = 7;

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function PodsPage() {
  const now = useNow();
  const pods = usePods();
  const dataUpdatedAt = () => pods.dataUpdatedAt;

  const groups = createMemo(() => pods.data?.projects ?? []);
  const totalRunning = createMemo(() => groups().reduce((sum, group) => sum + group.environments.length, 0));

  const [collapsed, setCollapsed] = createSignal<Set<string>>(new Set());
  const toggleGroup = (projectId: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });

  const [expanded, setExpanded] = createSignal<Set<string>>(new Set());
  const toggleRow = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div class="w-full overflow-y-auto h-full px-4 py-6">
      <div class="flex items-center gap-3 mb-1">
        <Boxes class="w-5 h-5 text-muted-foreground" />
        <h1 class="text-xl font-semibold">Pods</h1>
        <Show when={!pods.isPending}>
          <Badge variant="secondary" class="text-[10px] px-1.5 py-0">
            {totalRunning()}
          </Badge>
        </Show>
        <div class="ml-auto">
          <LiveIndicator
            now={now}
            updatedAt={dataUpdatedAt}
            fetching={pods.isFetching}
            onRefresh={() => pods.refetch()}
          />
        </div>
      </div>

      <p class="text-xs text-muted-foreground mb-3 ml-8">
        Running environment pods across this organization, grouped by project. Refreshes automatically.
      </p>

      <div class="ml-8 mb-5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span class="inline-flex items-center gap-1.5">
          <span class="size-1.5 rounded-full bg-indigo-500" />
          Agent activity
        </span>
        <span class="inline-flex items-center gap-1.5">
          <span class="size-1.5 rounded-full bg-emerald-500" />
          App activity
        </span>
        <span class="text-muted-foreground/70">A pod stays alive until both have been idle past their timeout.</span>
      </div>

      <Show when={pods.isPending}>
        <LoadingState />
      </Show>

      <Show when={!pods.isPending && pods.isError}>
        <ErrorState onRetry={() => pods.refetch()} />
      </Show>

      <Show when={!pods.isPending && !pods.isError && groups().length === 0}>
        <EmptyState />
      </Show>

      <Show when={!pods.isPending && !pods.isError && groups().length > 0}>
        <div class="rounded-lg border border-border overflow-hidden bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead class="min-w-48">Environment</TableHead>
                <TableHead class="w-44">Status</TableHead>
                <TableHead class="w-20">Age</TableHead>
                <TableHead class="w-24">Resources</TableHead>
                <TableHead class="min-w-56">Keep-alive</TableHead>
                <TableHead class="w-28">Timeout</TableHead>
                <TableHead class="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              <For each={groups()}>
                {(group) => (
                  <>
                    <TableRow class="border-b-0 hover:bg-transparent">
                      <TableCell colspan={COLUMN_COUNT} class="bg-muted/40 py-2">
                        <div class="flex items-center gap-3">
                          <button
                            type="button"
                            onClick={() => toggleGroup(group.projectId)}
                            class="flex items-center gap-2 text-left min-w-0"
                            aria-expanded={!collapsed().has(group.projectId)}
                          >
                            <ChevronRight
                              class={cn(
                                'w-3.5 h-3.5 shrink-0 text-muted-foreground transition-transform',
                                !collapsed().has(group.projectId) && 'rotate-90'
                              )}
                            />
                            <FolderKanban class="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                            <span class="font-medium text-sm truncate">
                              {group.projectTitle?.trim() || 'Untitled project'}
                            </span>
                            <Badge variant="secondary" class="text-[10px] px-1.5 py-0 shrink-0">
                              {group.environments.length}
                            </Badge>
                          </button>
                          <Tooltip>
                            <TooltipTrigger as="span" class="shrink-0">
                              <Link
                                to="/projects/$projectId"
                                params={{ projectId: group.projectId }}
                                search={{ prompt: undefined, promptId: undefined }}
                                class="inline-flex items-center justify-center w-6 h-6 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                                aria-label="Open project"
                              >
                                <ExternalLink class="w-3.5 h-3.5" />
                              </Link>
                            </TooltipTrigger>
                            <TooltipContent>Open project</TooltipContent>
                          </Tooltip>
                          <Show when={group.ghostCount > 0}>
                            <span class="inline-flex items-center gap-1 text-[11px] text-amber-600 shrink-0">
                              <AlertTriangle class="w-3 h-3" />
                              {group.ghostCount} active{' '}
                              {group.ghostCount === 1 ? 'environment has' : 'environments have'} no pod
                            </span>
                          </Show>
                        </div>
                      </TableCell>
                    </TableRow>

                    <Show when={!collapsed().has(group.projectId)}>
                      <For each={group.environments}>
                        {(row) => (
                          <PodEnvRow
                            row={row}
                            now={now}
                            dataUpdatedAt={dataUpdatedAt}
                            expanded={expanded().has(row.projectEnvironmentId)}
                            onToggle={() => toggleRow(row.projectEnvironmentId)}
                          />
                        )}
                      </For>
                    </Show>
                  </>
                )}
              </For>
            </TableBody>
          </Table>
        </div>
      </Show>
    </div>
  );
}

function PodEnvRow(props: {
  row: PodRow;
  now: () => number;
  dataUpdatedAt: () => number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const liveAgeMs = () => props.row.ageMs + elapsedSince(props.now(), props.dataUpdatedAt());

  return (
    <>
      <TableRow class="cursor-pointer" onClick={props.onToggle}>
        <TableCell>
          <div class="font-medium text-sm">{props.row.environmentName}</div>
          <Show when={props.row.environmentSlug}>
            {(slug) => <span class="font-mono text-[11px] text-muted-foreground">{slug()}</span>}
          </Show>
        </TableCell>

        <TableCell>
          <PodStatusCell
            status={props.row.status}
            drift={props.row.drift}
            dbStatus={props.row.dbStatus}
            skillDelivery={props.row.skillDelivery}
            agentUpdate={props.row.agentUpdate}
          />
        </TableCell>

        <TableCell>
          <Tooltip>
            <TooltipTrigger as="span" class="text-xs tabular-nums text-muted-foreground">
              {formatDuration(liveAgeMs())}
            </TooltipTrigger>
            <TooltipContent>
              <Show when={props.row.detail.startedAtMs !== null} fallback="Start time unknown">
                Started {formatClock(props.row.detail.startedAtMs ?? 0)}
              </Show>
            </TooltipContent>
          </Tooltip>
        </TableCell>

        <TableCell>
          <Tooltip>
            <TooltipTrigger as="span">
              <Badge variant="outline" class="text-[11px] font-normal">
                {titleCase(props.row.resources.podClass)}
              </Badge>
            </TooltipTrigger>
            <TooltipContent>
              {formatCores(props.row.resources.cpuMillicores)} · {formatGib(props.row.resources.memoryRequestMib)}–
              {formatGib(props.row.resources.memoryLimitMib)} memory
            </TooltipContent>
          </Tooltip>
        </TableCell>

        <TableCell>
          <KeepAliveCell
            keepAlive={props.row.keepAlive}
            timeout={props.row.timeout}
            now={props.now}
            dataUpdatedAt={props.dataUpdatedAt}
          />
        </TableCell>

        <TableCell>
          <Tooltip>
            <TooltipTrigger as="div" class="text-xs tabular-nums text-muted-foreground">
              {formatDuration(props.row.timeout.agentIdleMs)}
              <span class="px-1 text-muted-foreground/40">/</span>
              {formatDuration(props.row.timeout.appIdleMs)}
            </TooltipTrigger>
            <TooltipContent>
              Agent idle {formatDuration(props.row.timeout.agentIdleMs)} · App idle{' '}
              {formatDuration(props.row.timeout.appIdleMs)}
            </TooltipContent>
          </Tooltip>
        </TableCell>

        <TableCell class="text-right pr-3">
          <ChevronRight
            class={cn('w-4 h-4 inline text-muted-foreground transition-transform', props.expanded && 'rotate-90')}
          />
        </TableCell>
      </TableRow>

      <Show when={props.expanded}>
        <TableRow class="hover:bg-transparent">
          <TableCell colspan={COLUMN_COUNT} class="bg-muted/30">
            <div class="grid grid-cols-2 sm:grid-cols-4 gap-x-8 gap-y-2.5 py-1">
              <DetailField label="Pod" mono value={props.row.podName} />
              <DetailField label="Pod IP" mono value={props.row.detail.podIp ?? '—'} />
              <DetailField label="Restarts" value={String(props.row.status.restartCount)} />
              <DetailField
                label="Started"
                value={props.row.detail.startedAtMs !== null ? formatClock(props.row.detail.startedAtMs) : '—'}
              />
            </div>
          </TableCell>
        </TableRow>
      </Show>
    </>
  );
}

function DetailField(props: { label: string; value: string; mono?: boolean }) {
  return (
    <div class="min-w-0">
      <div class="text-[10px] uppercase tracking-wide text-muted-foreground/70">{props.label}</div>
      <div class={cn('text-xs truncate', props.mono ? 'font-mono' : '')}>{props.value}</div>
    </div>
  );
}

function LiveIndicator(props: {
  now: () => number;
  updatedAt: () => number;
  fetching: boolean;
  onRefresh: () => void;
}) {
  const ago = () => {
    const updatedAt = props.updatedAt();
    if (!updatedAt) return '';
    return formatAgo(elapsedSince(props.now(), updatedAt));
  };

  return (
    <div class="flex items-center gap-2 text-xs text-muted-foreground">
      <span class="relative flex size-2">
        <span class="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60 animate-ping motion-reduce:hidden" />
        <span class="relative inline-flex size-2 rounded-full bg-emerald-500" />
      </span>
      <Show when={ago()}>{(text) => <span class="tabular-nums">Updated {text()}</span>}</Show>
      <button
        type="button"
        onClick={() => props.onRefresh()}
        class="inline-flex items-center justify-center rounded-md w-7 h-7 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
        aria-label="Refresh pods"
      >
        <RefreshCw class={cn('w-3.5 h-3.5', props.fetching && 'animate-spin')} />
      </button>
    </div>
  );
}

function LoadingState() {
  return (
    <div class="rounded-lg border border-border overflow-hidden bg-card divide-y divide-border">
      <For each={[0, 1, 2, 3]}>
        {() => (
          <div class="flex items-center gap-4 px-4 py-3.5">
            <Skeleton class="h-4 w-40" />
            <Skeleton class="h-4 w-24" />
            <Skeleton class="h-4 w-12" />
            <Skeleton class="h-8 w-56 ml-auto" />
          </div>
        )}
      </For>
    </div>
  );
}

function ErrorState(props: { onRetry: () => void }): JSX.Element {
  return (
    <div class="rounded-lg border border-dashed border-border text-center py-16 text-muted-foreground">
      <AlertTriangle class="w-10 h-10 mx-auto mb-3 text-amber-500 opacity-70" />
      <p class="text-sm font-medium text-foreground">Couldn't load pods</p>
      <p class="text-xs mt-1">The pod list is temporarily unavailable.</p>
      <button
        type="button"
        onClick={() => props.onRetry()}
        class="mt-4 inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent transition-colors"
      >
        <RefreshCw class="w-3.5 h-3.5" />
        Try again
      </button>
    </div>
  );
}

function EmptyState(): JSX.Element {
  return (
    <div class="rounded-lg border border-dashed border-border text-center py-16 text-muted-foreground">
      <Boxes class="w-10 h-10 mx-auto mb-3 opacity-40" />
      <p class="text-sm font-medium">No running pods</p>
      <p class="text-xs mt-1">Environments spin up when someone opens a project or its app receives traffic.</p>
    </div>
  );
}
