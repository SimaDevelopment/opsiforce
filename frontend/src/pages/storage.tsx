import { createMemo, createSignal, For, Show, type Component, type JSX } from 'solid-js';
import { toast } from 'solid-sonner';
import {
  useCleanupTenantStorage,
  usePlatformStorage,
  type PlatformStorageBuckets,
  type PlatformStorageProject,
  type PlatformStorageTemplates,
  type PlatformStorageTenant,
  type PlatformStorageView,
} from '~/api/platform-storage';
import { usePermissions } from '~/api/permissions';
import { Permission } from '~/constants/permissions';
import { ConfirmDialog } from '~/components/ui/confirm-dialog';
import { Popover, PopoverTrigger, PopoverContent } from '~/components/ui/popover';
import { formatBytes, formatShare } from '~/lib/format-bytes';
import { cn } from '~/lib/cn';
import { Badge, badgeVariants } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Skeleton } from '~/components/ui/skeleton';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '~/components/ui/table';
import { Tooltip, TooltipTrigger, TooltipContent } from '~/components/ui/tooltip';
import {
  AlertTriangle,
  Building2,
  ChevronDown,
  ChevronRight,
  Clock,
  Database,
  Download,
  Files,
  FolderKanban,
  Inbox,
  Layers,
  RefreshCw,
  Trash2,
  Upload,
} from '~/components/icons';

const COLUMN_COUNT = 4;
const STALENESS_NOTE = 'sizes may lag recent writes by ~30 s';

const TENANT_SEGMENT_COLORS = [
  'bg-indigo-500',
  'bg-emerald-500',
  'bg-sky-500',
  'bg-violet-500',
  'bg-rose-500',
  'bg-teal-500',
];
const UNATTRIBUTED_COLOR = 'bg-slate-400';
const UNACCOUNTED_COLOR = 'bg-amber-400';

const CAPACITY_SUSPECT_NOTE =
  'The volume quota could not be confirmed, so the claim’s capacity and used bytes are not trustworthy — statfs may be reporting the whole cluster. Measured directory sizes below are unaffected.';
const UNACCOUNTED_NOTE =
  'Claim usage minus everything measured above. Small values are recursive-statistic propagation lag, not lost storage.';

function tenantColor(index: number): string {
  return TENANT_SEGMENT_COLORS[index % TENANT_SEGMENT_COLORS.length];
}

function agentCount(count: number): string {
  return `${count} ${count === 1 ? 'agent' : 'agents'}`;
}

function formatSnapshotClock(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  return at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

interface BucketRow {
  label: string;
  bytes: number;
  error: boolean;
  detail?: string;
  icon: Component<{ class?: string }>;
}

function bucketRows(buckets: PlatformStorageBuckets): BucketRow[] {
  return [
    { label: 'Pool (unclaimed projects)', bytes: buckets.pool.bytes, error: buckets.pool.error, icon: Inbox },
    {
      label: 'Tombstoned (deleted pool projects)',
      bytes: buckets.tombstoned.bytes,
      error: buckets.tombstoned.error,
      icon: Trash2,
    },
    {
      label: 'Orphaned directories',
      bytes: buckets.orphaned.bytes,
      error: buckets.orphaned.error,
      detail: `${buckets.orphaned.count} ${buckets.orphaned.count === 1 ? 'directory' : 'directories'}`,
      icon: Layers,
    },
    {
      label: 'Agent Templates (no organization)',
      bytes: buckets.templates.bytes,
      error: buckets.templates.error,
      detail: agentCount(buckets.templates.count),
      icon: Files,
    },
    { label: 'Exports', bytes: buckets.exports.bytes, error: buckets.exports.error, icon: Download },
    { label: 'Imports', bytes: buckets.imports.bytes, error: buckets.imports.error, icon: Upload },
  ];
}

function bucketsTotalBytes(buckets: PlatformStorageBuckets): number {
  return bucketRows(buckets).reduce((total, row) => total + row.bytes, 0);
}

function bucketsErrored(buckets: PlatformStorageBuckets): boolean {
  return bucketRows(buckets).some((row) => row.error);
}

function shownUnaccountedBytes(snapshot: PlatformStorageView): number {
  return snapshot.capacitySuspect ? 0 : Math.max(snapshot.unaccountedBytes, 0);
}

function hasLedgerRows(snapshot: PlatformStorageView): boolean {
  return snapshot.tenants.length > 0 || bucketsTotalBytes(snapshot.buckets) > 0 || shownUnaccountedBytes(snapshot) > 0;
}

function useToggleSet() {
  const [open, setOpen] = createSignal<Set<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return { has: (id: string) => open().has(id), toggle };
}

export function StoragePage() {
  const storage = usePlatformStorage();
  const snapshot = () => storage.data;
  const loaded = createMemo(() => (storage.isPending || storage.isError ? undefined : storage.data));

  return (
    <div class="w-full overflow-y-auto h-full px-4 py-6">
      <div class="flex items-center gap-3 mb-1">
        <Database class="w-5 h-5 text-muted-foreground" />
        <h1 class="text-xl font-semibold">Storage</h1>
        <Show when={snapshot()}>{(view) => <CapacityBadge snapshot={view()} />}</Show>
        <Show when={snapshot()}>
          {(view) => (
            <div class="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
              <Clock class="w-3.5 h-3.5" />
              <span class="tabular-nums">
                Snapshot {formatSnapshotClock(view().computedAt)} · {STALENESS_NOTE}
              </span>
            </div>
          )}
        </Show>
      </div>

      <p class="text-xs text-muted-foreground mb-4 ml-8">
        Disk usage on the shared storage volume, across all organizations.
      </p>

      <Show when={storage.isPending}>
        <LoadingState />
      </Show>

      <Show when={!storage.isPending && storage.isError}>
        <ErrorState onRetry={() => storage.refetch()} />
      </Show>

      <Show when={loaded()}>
        {(view) => (
          <>
            <CapacityBar snapshot={view()} />
            <Show when={hasLedgerRows(view())} fallback={<EmptyState />}>
              <RollupTable snapshot={view()} />
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}

function CapacityBadge(props: { snapshot: PlatformStorageView }) {
  return (
    <Show
      when={!props.snapshot.capacitySuspect}
      fallback={
        <Tooltip>
          <TooltipTrigger
            as="span"
            class={cn(badgeVariants({ variant: 'warning' }), 'text-[10px] px-2 py-0 gap-1 cursor-default')}
          >
            <AlertTriangle class="w-3 h-3" />
            Capacity unverified
          </TooltipTrigger>
          <TooltipContent>{CAPACITY_SUSPECT_NOTE}</TooltipContent>
        </Tooltip>
      }
    >
      <Badge variant="secondary" class="text-[10px] px-2 py-0 font-medium tabular-nums">
        {formatBytes(props.snapshot.usedBytes)} / {formatBytes(props.snapshot.capacityBytes)}
      </Badge>
    </Show>
  );
}

function CapacityBar(props: { snapshot: PlatformStorageView }) {
  const unattributedBytes = createMemo(() => bucketsTotalBytes(props.snapshot.buckets));
  const unaccountedBytes = createMemo(() => shownUnaccountedBytes(props.snapshot));
  const freeBytes = createMemo(() => Math.max(props.snapshot.capacityBytes - props.snapshot.usedBytes, 0));
  const tenantSegments = createMemo(() =>
    props.snapshot.tenants
      .map((tenant, index) => ({ name: tenant.name, bytes: tenant.totalBytes, color: tenantColor(index) }))
      .filter((segment) => segment.bytes > 0)
  );
  const measuredBytes = createMemo(
    () => props.snapshot.tenants.reduce((sum, tenant) => sum + tenant.totalBytes, 0) + unattributedBytes()
  );
  const scaleBytes = createMemo(() =>
    props.snapshot.capacitySuspect ? measuredBytes() : props.snapshot.capacityBytes
  );
  const width = (bytes: number) => (scaleBytes() <= 0 ? 0 : (bytes / scaleBytes()) * 100);

  return (
    <div class="ml-8 mb-6">
      <div class="flex h-3 rounded-full bg-muted overflow-hidden">
        <For each={tenantSegments()}>
          {(segment) => (
            <div
              class={cn('h-full', segment.color)}
              style={{ width: `${width(segment.bytes)}%` }}
              title={`${segment.name} · ${formatBytes(segment.bytes)}`}
            />
          )}
        </For>
        <Show when={unattributedBytes() > 0}>
          <div
            class={cn('h-full', UNATTRIBUTED_COLOR)}
            style={{ width: `${width(unattributedBytes())}%` }}
            title={`Unattributed · ${formatBytes(unattributedBytes())}`}
          />
        </Show>
        <Show when={unaccountedBytes() > 0}>
          <div
            class={cn('h-full', UNACCOUNTED_COLOR)}
            style={{ width: `${width(unaccountedBytes())}%` }}
            title={`Unaccounted · ${formatBytes(unaccountedBytes())}`}
          />
        </Show>
      </div>

      <div class="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-[11px] text-muted-foreground">
        <LegendItem color={TENANT_SEGMENT_COLORS[0]} label="Organizations" />
        <LegendItem color={UNATTRIBUTED_COLOR} label="Unattributed" />
        <Show when={!props.snapshot.capacitySuspect}>
          <LegendItem color={UNACCOUNTED_COLOR} label="Unaccounted" />
          <span class="text-muted-foreground/70 tabular-nums">{formatBytes(freeBytes())} free</span>
        </Show>
        <Show when={props.snapshot.capacitySuspect}>
          <Tooltip>
            <TooltipTrigger as="span" class="inline-flex items-center gap-1 text-amber-600 cursor-default">
              <AlertTriangle class="w-3 h-3" />
              Claim capacity unverified — showing the composition of measured storage only
            </TooltipTrigger>
            <TooltipContent>{CAPACITY_SUSPECT_NOTE}</TooltipContent>
          </Tooltip>
        </Show>
      </div>
    </div>
  );
}

function LegendItem(props: { color: string; label: string }) {
  return (
    <span class="inline-flex items-center gap-1.5">
      <span class={cn('w-1.5 h-1.5 rounded-full', props.color)} />
      {props.label}
    </span>
  );
}

function RollupTable(props: { snapshot: PlatformStorageView }) {
  const tenants = useToggleSet();
  const projects = useToggleSet();

  const largestTenantBytes = createMemo(() =>
    props.snapshot.tenants.reduce((max, tenant) => Math.max(max, tenant.totalBytes), 0)
  );
  const buckets = createMemo(() => bucketRows(props.snapshot.buckets));
  const unattributedBytes = createMemo(() => bucketsTotalBytes(props.snapshot.buckets));
  const shareBaseBytes = createMemo(() =>
    props.snapshot.capacitySuspect
      ? props.snapshot.tenants.reduce((sum, tenant) => sum + tenant.totalBytes, 0) + unattributedBytes()
      : props.snapshot.usedBytes
  );

  return (
    <div class="rounded-lg border border-border overflow-hidden bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead class="min-w-64">Name</TableHead>
            <TableHead class="w-32 text-right">Size</TableHead>
            <TableHead class="w-24 text-right">Share</TableHead>
            <TableHead class="min-w-40" />
          </TableRow>
        </TableHeader>
        <TableBody>
          <For each={props.snapshot.tenants}>
            {(tenant, index) => (
              <>
                <TenantRow
                  tenant={tenant}
                  color={tenantColor(index())}
                  shareBaseBytes={shareBaseBytes()}
                  expanded={tenants.has(tenant.id)}
                  onToggle={() => tenants.toggle(tenant.id)}
                />
                <Show when={tenants.has(tenant.id)}>
                  <TemplatesRow
                    templates={tenant.templates}
                    shareBaseBytes={shareBaseBytes()}
                    maxBytes={largestTenantBytes()}
                  />
                  <For each={tenant.projects}>
                    {(project) => (
                      <>
                        <ProjectRow
                          project={project}
                          shareBaseBytes={shareBaseBytes()}
                          maxBytes={largestTenantBytes()}
                          expanded={projects.has(project.id)}
                          onToggle={() => projects.toggle(project.id)}
                        />
                        <Show when={projects.has(project.id)}>
                          <For each={project.environments}>
                            {(environment) => (
                              <TableRow class="hover:bg-transparent">
                                <TableCell class="py-1.5">
                                  <div class="flex items-center gap-2 pl-16">
                                    <span class="text-xs" title={environment.directory}>
                                      {environment.environmentName}
                                    </span>
                                  </div>
                                </TableCell>
                                <TableCell class="py-1.5 text-right text-xs tabular-nums text-muted-foreground">
                                  <SizeValue bytes={environment.bytes} error={environment.error} />
                                </TableCell>
                                <TableCell class="py-1.5 text-right text-xs tabular-nums text-muted-foreground">
                                  <Show when={!environment.error && environment.bytes !== null} fallback="—">
                                    {formatShare(environment.bytes ?? 0, shareBaseBytes())}
                                  </Show>
                                </TableCell>
                                <TableCell class="py-1.5">
                                  <Show when={!environment.error && environment.bytes !== null}>
                                    <SizeBar bytes={environment.bytes ?? 0} max={largestTenantBytes()} />
                                  </Show>
                                </TableCell>
                              </TableRow>
                            )}
                          </For>
                        </Show>
                      </>
                    )}
                  </For>
                </Show>
              </>
            )}
          </For>

          <TableRow class="border-b-0 hover:bg-transparent">
            <TableCell colspan={COLUMN_COUNT} class="bg-muted/40 py-2">
              <div class="flex items-center gap-2">
                <Layers class="w-3.5 h-3.5 shrink-0 text-muted-foreground ml-5" />
                <span class="font-medium text-sm">Unattributed</span>
                <Show when={bucketsErrored(props.snapshot.buckets)}>
                  <MeasurementError label="Some directories could not be measured; this total is incomplete." />
                </Show>
                <span class="ml-auto text-sm tabular-nums font-medium">{formatBytes(unattributedBytes())}</span>
                <span class="w-20 text-right text-xs tabular-nums text-muted-foreground">
                  {formatShare(unattributedBytes(), shareBaseBytes())}
                </span>
                <span class="min-w-40" />
              </div>
            </TableCell>
          </TableRow>

          <For each={buckets()}>
            {(bucket) => (
              <TableRow class="hover:bg-transparent">
                <TableCell>
                  <div class="flex items-center gap-2 pl-6">
                    <bucket.icon class="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                    <span class="text-sm truncate">{bucket.label}</span>
                    <Show when={bucket.detail}>
                      <span class="text-xs text-muted-foreground shrink-0">· {bucket.detail}</span>
                    </Show>
                    <Show when={bucket.error}>
                      <MeasurementError label="Some directories could not be measured; this total is incomplete." />
                    </Show>
                  </div>
                </TableCell>
                <TableCell class="text-right text-sm tabular-nums">{formatBytes(bucket.bytes)}</TableCell>
                <TableCell class="text-right text-xs tabular-nums text-muted-foreground">
                  {formatShare(bucket.bytes, shareBaseBytes())}
                </TableCell>
                <TableCell>
                  <SizeBar bytes={bucket.bytes} max={largestTenantBytes()} />
                </TableCell>
              </TableRow>
            )}
          </For>

          <UnaccountedRow snapshot={props.snapshot} />
        </TableBody>
      </Table>
    </div>
  );
}

function UnaccountedRow(props: { snapshot: PlatformStorageView }) {
  const displayBytes = () => shownUnaccountedBytes(props.snapshot);

  return (
    <TableRow class="hover:bg-transparent">
      <TableCell>
        <div class="flex items-center gap-2 pl-6">
          <span class="text-sm text-muted-foreground">Unaccounted residual</span>
          <Tooltip>
            <TooltipTrigger
              as="span"
              class="text-xs text-muted-foreground underline decoration-dotted cursor-default shrink-0"
            >
              what's this?
            </TooltipTrigger>
            <TooltipContent>
              {UNACCOUNTED_NOTE}
              <Show when={props.snapshot.capacitySuspect}> {CAPACITY_SUSPECT_NOTE}</Show>
            </TooltipContent>
          </Tooltip>
        </div>
      </TableCell>
      <TableCell class="text-right text-sm tabular-nums text-muted-foreground">
        <Show
          when={!props.snapshot.capacitySuspect}
          fallback={
            <Tooltip>
              <TooltipTrigger
                as="span"
                class="inline-flex items-center gap-1 text-[11px] text-amber-600 cursor-default"
              >
                <AlertTriangle class="w-3 h-3" />
                Unverified
              </TooltipTrigger>
              <TooltipContent>{CAPACITY_SUSPECT_NOTE}</TooltipContent>
            </Tooltip>
          }
        >
          <span class="inline-flex items-center gap-1.5">
            <Show when={props.snapshot.incomplete}>
              <MeasurementError label="Some directories could not be measured, so their bytes are missing from the rollup above and inflate this residual." />
            </Show>
            {formatBytes(displayBytes())}
          </span>
        </Show>
      </TableCell>
      <TableCell colspan={2} />
    </TableRow>
  );
}

function TenantRow(props: {
  tenant: PlatformStorageTenant;
  color: string;
  shareBaseBytes: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <TableRow class="border-b-0 hover:bg-transparent">
      <TableCell colspan={COLUMN_COUNT} class="bg-muted/40 py-2">
        <button
          type="button"
          onClick={() => props.onToggle()}
          class="flex w-full items-center gap-2 text-left"
          aria-expanded={props.expanded}
        >
          <ChevronRight
            class={cn('w-3.5 h-3.5 shrink-0 text-muted-foreground transition-transform', props.expanded && 'rotate-90')}
          />
          <Building2 class="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
          <span class="font-medium text-sm truncate">{props.tenant.name}</span>
          <span class={cn('w-1.5 h-1.5 rounded-full shrink-0', props.color)} />
          <Badge variant="secondary" class="text-[10px] px-1.5 py-0 shrink-0">
            {props.tenant.projects.length}
          </Badge>
          <PendingDeletionBadge tenant={props.tenant} />
          <Show when={props.tenant.error}>
            <MeasurementError label="Some directories could not be measured; this total is incomplete." />
          </Show>
          <span class="ml-auto text-sm tabular-nums font-medium">{formatBytes(props.tenant.totalBytes)}</span>
          <span class="w-20 text-right text-xs tabular-nums text-muted-foreground">
            {formatShare(props.tenant.totalBytes, props.shareBaseBytes)}
          </span>
          <span class="min-w-40" />
        </button>
      </TableCell>
    </TableRow>
  );
}

function pendingDeletionBadgeClass(interactive: boolean): string {
  return cn(
    badgeVariants({ variant: 'outline' }),
    'text-[10px] px-1.5 py-0 gap-1 font-normal text-muted-foreground shrink-0',
    interactive ? 'cursor-pointer hover:bg-muted' : 'cursor-default'
  );
}

function PendingDeletionBadge(props: { tenant: PlatformStorageTenant }) {
  const { hasPermission } = usePermissions();
  const cleanup = useCleanupTenantStorage();
  const [confirmOpen, setConfirmOpen] = createSignal(false);

  const pending = () => props.tenant.pendingDeletion;
  const visible = () => pending().error || pending().count > 0 || pending().bytes > 0;
  const canCleanup = () => hasPermission(Permission.managePlatformStorage) && pending().count > 0;

  const badgeBody = () => (
    <>
      <Trash2 class="w-2.5 h-2.5" />
      <Show when={!pending().error} fallback={<>pending deletion unmeasured</>}>
        <span class="tabular-nums">{formatBytes(pending().bytes)}</span> pending deletion ·{' '}
        <span class="tabular-nums">{pending().count}</span>
      </Show>
    </>
  );

  const summary = () => (
    <Show
      when={!pending().error}
      fallback="Some pending-deletion directories could not be measured; this aggregate is incomplete."
    >
      {pending().count} {pending().count === 1 ? 'directory' : 'directories'} of deleted project environments still on
      disk for the recovery window. Cleanup will reclaim {formatBytes(pending().bytes)}.
    </Show>
  );

  const startCleanup = () => {
    cleanup.mutate(props.tenant.id, {
      onSuccess: () => toast.success('Cleanup started in the background — space will be reclaimed shortly'),
      onError: () => toast.error('Failed to start cleanup'),
    });
  };

  return (
    <Show when={visible()}>
      <Show
        when={canCleanup()}
        fallback={
          <Tooltip>
            <TooltipTrigger as="span" class={pendingDeletionBadgeClass(false)}>
              {badgeBody()}
            </TooltipTrigger>
            <TooltipContent>{summary()}</TooltipContent>
          </Tooltip>
        }
      >
        <Popover>
          <PopoverTrigger
            as="span"
            class={pendingDeletionBadgeClass(true)}
            onClick={(event: MouseEvent) => event.stopPropagation()}
          >
            {badgeBody()}
            <ChevronDown class="w-2.5 h-2.5" />
          </PopoverTrigger>
          <PopoverContent class="w-72 space-y-2 p-3 text-xs" onClick={(event: MouseEvent) => event.stopPropagation()}>
            <p>{summary()}</p>
            <Button variant="destructive" size="sm" class="w-full" onClick={() => setConfirmOpen(true)}>
              Clean up now
            </Button>
          </PopoverContent>
        </Popover>
        <ConfirmDialog
          open={confirmOpen()}
          onOpenChange={setConfirmOpen}
          title={`Clean up ${props.tenant.name} storage now?`}
          description={`${pending().count} ${
            pending().count === 1 ? 'directory' : 'directories'
          } (${formatBytes(pending().bytes)}) will be removed immediately, skipping the remaining recovery window. This cannot be undone.`}
          confirmLabel="Clean up now"
          variant="destructive"
          onConfirm={startCleanup}
        />
      </Show>
    </Show>
  );
}

function ProjectRow(props: {
  project: PlatformStorageProject;
  shareBaseBytes: number;
  maxBytes: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <TableRow class="cursor-pointer" onClick={() => props.onToggle()}>
      <TableCell>
        <div class="flex items-center gap-2 pl-6">
          <ChevronRight
            class={cn('w-3.5 h-3.5 shrink-0 text-muted-foreground transition-transform', props.expanded && 'rotate-90')}
          />
          <FolderKanban class="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
          <span class="text-sm truncate">{props.project.title?.trim() || 'Untitled project'}</span>
          <Badge variant="secondary" class="text-[10px] px-1.5 py-0 shrink-0">
            {props.project.environments.length}
          </Badge>
          <Show when={props.project.error}>
            <MeasurementError label="Some environment directories could not be measured; this total is incomplete." />
          </Show>
        </div>
      </TableCell>
      <TableCell class="text-right text-sm tabular-nums">{formatBytes(props.project.totalBytes)}</TableCell>
      <TableCell class="text-right text-xs tabular-nums text-muted-foreground">
        {formatShare(props.project.totalBytes, props.shareBaseBytes)}
      </TableCell>
      <TableCell>
        <SizeBar bytes={props.project.totalBytes} max={props.maxBytes} />
      </TableCell>
    </TableRow>
  );
}

function TemplatesRow(props: { templates: PlatformStorageTemplates; shareBaseBytes: number; maxBytes: number }) {
  return (
    <Show when={props.templates.count > 0 || props.templates.error}>
      <TableRow class="hover:bg-transparent">
        <TableCell>
          <div class="flex items-center gap-2 pl-6">
            <span class="w-3.5 shrink-0" />
            <Files class="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
            <span class="text-sm truncate">Agent Templates</span>
            <span class="text-xs text-muted-foreground shrink-0">· {agentCount(props.templates.count)}</span>
            <Show when={props.templates.error}>
              <MeasurementError label="Some Template folders could not be measured; this total is incomplete." />
            </Show>
          </div>
        </TableCell>
        <TableCell class="text-right text-sm tabular-nums">{formatBytes(props.templates.bytes)}</TableCell>
        <TableCell class="text-right text-xs tabular-nums text-muted-foreground">
          {formatShare(props.templates.bytes, props.shareBaseBytes)}
        </TableCell>
        <TableCell>
          <SizeBar bytes={props.templates.bytes} max={props.maxBytes} />
        </TableCell>
      </TableRow>
    </Show>
  );
}

function SizeValue(props: { bytes: number | null; error: boolean }) {
  return (
    <Show
      when={!props.error && props.bytes !== null}
      fallback={<MeasurementError label="This directory could not be measured — the size is unknown, not zero." />}
    >
      {formatBytes(props.bytes ?? 0)}
    </Show>
  );
}

function MeasurementError(props: { label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        as="span"
        class="inline-flex items-center gap-1 text-[11px] text-amber-600 shrink-0 cursor-default"
      >
        <AlertTriangle class="w-3 h-3" />
        Unmeasured
      </TooltipTrigger>
      <TooltipContent>{props.label}</TooltipContent>
    </Tooltip>
  );
}

function SizeBar(props: { bytes: number; max: number }) {
  const width = () => (props.max <= 0 ? 0 : Math.max((props.bytes / props.max) * 100, 1));
  return (
    <div class="h-1.5 rounded-full bg-muted overflow-hidden max-w-40">
      <div class="h-full rounded-full bg-indigo-500/70" style={{ width: `${width()}%` }} />
    </div>
  );
}

function LoadingState() {
  return (
    <div class="rounded-lg border border-border overflow-hidden bg-card divide-y divide-border">
      <For each={[0, 1, 2, 3]}>
        {() => (
          <div class="flex items-center gap-4 px-4 py-3.5">
            <Skeleton class="h-4 w-48" />
            <Skeleton class="h-4 w-20 ml-auto" />
            <Skeleton class="h-4 w-12" />
            <Skeleton class="h-1.5 w-40" />
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
      <p class="text-sm font-medium text-foreground">Couldn't load the storage snapshot</p>
      <p class="text-xs mt-1">The request failed — the volume may be unreachable.</p>
      <Button variant="outline" size="sm" class="mt-4" onClick={() => props.onRetry()}>
        <RefreshCw class="w-3.5 h-3.5" />
        Try again
      </Button>
    </div>
  );
}

function EmptyState(): JSX.Element {
  return (
    <div class="rounded-lg border border-dashed border-border text-center py-16 text-muted-foreground">
      <Database class="w-10 h-10 mx-auto mb-3 opacity-40" />
      <p class="text-sm font-medium">No organization storage yet</p>
      <p class="text-xs mt-1">Environment directories appear here once projects have been opened.</p>
    </div>
  );
}
