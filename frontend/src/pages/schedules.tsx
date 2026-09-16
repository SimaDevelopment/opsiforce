import { Show, For, createSignal, createMemo, createEffect } from 'solid-js';
import { createMutation, useQueryClient } from '@tanstack/solid-query';
import { createAppQuery } from '~/lib/create-app-query';
import { Link, useNavigate, useSearch } from '@tanstack/solid-router';
import { scheduleApi, type Schedule, type ScheduleExecution, type UpdateScheduleDto } from '~/api/client';
import { useEnvironments, useProjectEnvironments } from '~/api/environments';
import { useProjects } from '~/api/projects';
import { usePermissions } from '~/api/permissions';
import { Permission } from '~/constants/permissions';
import { Calendar, Trash2, Pencil, Play, Clock, EllipsisVertical, ChevronLeft } from '~/components/icons';
import { Button } from '~/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '~/components/ui/tabs';
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogFooter } from '~/components/ui/dialog';
import ConfirmDialog from '~/components/ui/confirm-dialog';
import { Badge } from '~/components/ui/badge';
import Skeleton from '~/components/ui/skeleton';
import { CronPicker } from '~/components/ui/cron-picker';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '~/components/ui/table';
import { Switch, SwitchControl, SwitchThumb } from '~/components/ui/switch';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '~/components/ui/dropdown-menu';

function cronToHuman(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5) return expr;
  const [min, hour, , , dow] = parts;
  if (min === '*' && hour === '*') return 'Every minute';
  if (min.startsWith('*/')) return `Every ${min.slice(2)} min`;
  if (hour === '*') return `Hourly at :${min.padStart(2, '0')}`;
  const h = parseInt(hour);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  const time = `${h12}:${min.padStart(2, '0')} ${ampm}`;
  if (dow === '1-5') return `Weekdays ${time}`;
  if (dow !== '*') return `${dow} ${time}`;
  return `Daily ${time}`;
}

export function SchedulesPage() {
  const qc = useQueryClient();
  const search = useSearch({ from: '/schedules' });
  const navigate = useNavigate();
  const { permissions, hasPermission } = usePermissions();

  createEffect(() => {
    if (permissions.isPending) return;
    if (!hasPermission(Permission.manageSchedules)) {
      navigate({ to: '/' });
    }
  });

  const scopedProjectEnvId = createMemo(() => search().projectEnvironmentId);
  const scopedProjectId = createMemo(() => search().projectId);
  const isScoped = createMemo(() => !!scopedProjectEnvId());

  const environments = useEnvironments({ enabled: () => !isScoped() });
  const sortedEnvs = createMemo(() =>
    [...(environments.data ?? [])].toSorted((a, b) => {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      return a.name.localeCompare(b.name);
    })
  );
  const [selectedEnvId, setSelectedEnvId] = createSignal('');
  createEffect(() => {
    const envs = sortedEnvs();
    if (envs.length === 0) return;
    const fromSearch = search().environmentId;
    setSelectedEnvId(fromSearch && envs.some((e) => e.id === fromSearch) ? fromSearch : envs[0].id);
  });
  const activeEnvId = selectedEnvId;
  const selectEnv = (id: string) => {
    setSelectedEnvId(id);
    navigate({ to: '/schedules', search: { environmentId: id }, replace: true });
  };

  const [editSchedule, setEditSchedule] = createSignal<Schedule | null>(null);
  const [deleteTarget, setDeleteTarget] = createSignal<Schedule | null>(null);
  const [runTarget, setRunTarget] = createSignal<Schedule | null>(null);
  const [execSchedule, setExecSchedule] = createSignal<Schedule | null>(null);
  const [triggeredId, setTriggeredId] = createSignal<string | null>(null);

  const schedules = createAppQuery(() => ({
    queryKey: isScoped()
      ? ['schedules', 'project-environment', scopedProjectEnvId()]
      : ['schedules', 'environment', activeEnvId()],
    queryFn: () =>
      isScoped()
        ? scheduleApi.list({ projectEnvironmentId: scopedProjectEnvId() })
        : scheduleApi.list({ environmentId: activeEnvId() }),
    enabled: isScoped() ? !!scopedProjectEnvId() : !!activeEnvId(),
  }));

  const projects = useProjects({ enabled: () => isScoped() });
  const projectEnvironments = useProjectEnvironments(() => scopedProjectId() ?? '', {
    enabled: () => isScoped() && !!scopedProjectId(),
  });
  const scopedEnvName = createMemo(
    () =>
      projectEnvironments.data?.find((e) => e.id === scopedProjectEnvId())?.name ??
      schedules.data?.[0]?.environmentName ??
      null
  );
  const scopedProjectTitle = createMemo(
    () => projects.data?.find((p) => p.id === scopedProjectId())?.title ?? schedules.data?.[0]?.projectTitle ?? null
  );

  const executions = createAppQuery(() => ({
    queryKey: ['executions', execSchedule()?.id],
    queryFn: () => {
      const s = execSchedule();
      return s ? scheduleApi.getExecutions(s.id, s.projectId) : Promise.resolve([]);
    },
    enabled: !!execSchedule(),
  }));

  const removeMutation = createMutation(() => ({
    mutationFn: (s: Schedule) => scheduleApi.remove(s.projectId, s.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['schedules'] });
      setDeleteTarget(null);
    },
  }));

  const updateMutation = createMutation(() => ({
    mutationFn: (args: { s: Schedule; dto: UpdateScheduleDto }) =>
      scheduleApi.update(args.s.projectId, args.s.id, args.dto),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['schedules'] });
      setEditSchedule(null);
    },
  }));

  const runNow = async (s: Schedule) => {
    setTriggeredId(s.id);
    await scheduleApi.triggerRun(s.projectId, s.id);
    setTimeout(() => setTriggeredId(null), 2000);
    qc.invalidateQueries({ queryKey: ['executions', s.id] });
  };

  const toggleActive = (s: Schedule) => {
    updateMutation.mutate({ s, dto: { isActive: !s.isActive } });
  };

  const count = () => schedules.data?.length ?? 0;

  return (
    <div class="w-full px-4 py-6">
      <Show when={isScoped()}>
        <Link
          to="/schedules"
          search={{ environmentId: undefined, projectEnvironmentId: undefined, projectId: undefined }}
          class="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mb-3"
        >
          <ChevronLeft class="w-3.5 h-3.5" />
          All schedules
        </Link>
      </Show>

      <div class="flex items-center gap-3 mb-1">
        <Calendar class="w-5 h-5 text-muted-foreground" />
        <h1 class="text-xl font-semibold">Schedules</h1>
        <Show when={!schedules.isPending && (isScoped() || !!activeEnvId())}>
          <Badge variant="secondary" class="text-[10px] px-1.5 py-0">
            {count()}
          </Badge>
        </Show>
      </div>

      <Show
        when={isScoped()}
        fallback={
          <p class="text-xs text-muted-foreground mb-5 ml-8">
            Automated tasks that run on a recurring schedule. Pick an environment to see its schedules.
          </p>
        }
      >
        <p class="text-xs text-muted-foreground mb-5 ml-8">
          <Show when={scopedProjectTitle()} fallback="Automated tasks for this environment.">
            {(title) => (
              <>
                Automated tasks for{' '}
                <Link
                  to="/projects/$projectId"
                  params={{ projectId: scopedProjectId() ?? '' }}
                  search={{ prompt: undefined, promptId: undefined }}
                  class="text-primary hover:underline underline-offset-2"
                >
                  {title()}
                </Link>
                <Show when={scopedEnvName()}>{(name) => <> · {name()}</>}</Show>
              </>
            )}
          </Show>
        </p>
      </Show>

      <Show when={isScoped()}>
        <ScheduleTableSection
          pending={schedules.isPending}
          schedules={schedules.data}
          showProject={false}
          updating={updateMutation.isPending}
          triggeredId={triggeredId()}
          onToggle={toggleActive}
          onRun={(s) => setRunTarget(s)}
          onViewExecutions={(s) => setExecSchedule(s)}
          onEdit={(s) => setEditSchedule(s)}
          onDelete={(s) => setDeleteTarget(s)}
        />
      </Show>

      <Show when={!isScoped()}>
        <Show when={!environments.isPending} fallback={<Skeleton class="h-9 w-full" />}>
          <Tabs value={activeEnvId()} onChange={selectEnv}>
            <TabsList class="w-auto">
              <For each={sortedEnvs()}>
                {(env) => (
                  <TabsTrigger value={env.id} class="flex-none">
                    {env.name}
                  </TabsTrigger>
                )}
              </For>
            </TabsList>
            <TabsContent value={activeEnvId()}>
              <ScheduleTableSection
                pending={schedules.isPending}
                schedules={schedules.data}
                showProject={true}
                updating={updateMutation.isPending}
                triggeredId={triggeredId()}
                onToggle={toggleActive}
                onRun={(s) => setRunTarget(s)}
                onViewExecutions={(s) => setExecSchedule(s)}
                onEdit={(s) => setEditSchedule(s)}
                onDelete={(s) => setDeleteTarget(s)}
              />
            </TabsContent>
          </Tabs>
        </Show>
      </Show>

      <EditScheduleDialog
        schedule={editSchedule()}
        onClose={() => setEditSchedule(null)}
        onSave={(dto) => {
          const s = editSchedule();
          if (s) updateMutation.mutate({ s, dto });
        }}
      />

      <ConfirmDialog
        open={!!deleteTarget()}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={`Delete schedule "${deleteTarget()?.name}"`}
        description="This will permanently remove the schedule and all its execution history."
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={() => {
          const t = deleteTarget();
          if (t) removeMutation.mutate(t);
        }}
      />

      <ConfirmDialog
        open={!!runTarget()}
        onOpenChange={(open) => {
          if (!open) setRunTarget(null);
        }}
        title={`Run "${runTarget()?.name}" now?`}
        description={
          `This triggers the schedule immediately, outside its normal cron window. ` +
          `It will fire ${runTarget()?.targetPath ?? 'the configured target'} once and record the run in execution history.`
        }
        confirmLabel="Run now"
        onConfirm={() => {
          const t = runTarget();
          if (t) {
            runNow(t);
            setRunTarget(null);
          }
        }}
      />

      <ExecutionsDialog
        schedule={execSchedule()}
        executions={executions.data ?? []}
        loading={executions.isPending}
        onClose={() => setExecSchedule(null)}
      />
    </div>
  );
}

function ScheduleTableSection(props: {
  pending: boolean;
  schedules: Schedule[] | undefined;
  showProject: boolean;
  updating: boolean;
  triggeredId: string | null;
  onToggle: (s: Schedule) => void;
  onRun: (s: Schedule) => void;
  onViewExecutions: (s: Schedule) => void;
  onEdit: (s: Schedule) => void;
  onDelete: (s: Schedule) => void;
}) {
  const count = () => props.schedules?.length ?? 0;
  return (
    <>
      <Show when={props.pending}>
        <div class="rounded-lg border border-border overflow-hidden bg-card divide-y divide-border">
          <For each={[0, 1, 2]}>
            {() => (
              <div class="flex items-center gap-3 px-4 py-3">
                <Skeleton class="h-4 w-40" />
                <Skeleton class="h-4 w-32" />
                <Skeleton class="h-4 w-24" />
                <Skeleton class="h-4 w-16 ml-auto" />
              </div>
            )}
          </For>
        </div>
      </Show>

      <Show when={!props.pending && count() === 0}>
        <div class="rounded-lg border border-dashed border-border text-center py-16 text-muted-foreground">
          <Calendar class="w-10 h-10 mx-auto mb-3 opacity-40" />
          <p class="text-sm font-medium">No schedules in this environment</p>
        </div>
      </Show>

      <Show when={count() > 0}>
        <div class="rounded-lg border border-border overflow-hidden bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <Show when={props.showProject}>
                  <TableHead>Project</TableHead>
                </Show>
                <TableHead>Schedule</TableHead>
                <TableHead>Timezone</TableHead>
                <TableHead>Active</TableHead>
                <TableHead class="text-right pr-4">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <For each={props.schedules}>
                {(s) => (
                  <TableRow>
                    <TableCell class="font-medium">{s.name}</TableCell>
                    <Show when={props.showProject}>
                      <TableCell>
                        <Link
                          to="/projects/$projectId"
                          params={{ projectId: s.projectId }}
                          search={{ prompt: undefined, promptId: undefined }}
                          class="text-xs text-primary hover:underline underline-offset-2"
                        >
                          {s.projectTitle ?? s.projectId.slice(0, 8)}
                        </Link>
                      </TableCell>
                    </Show>
                    <TableCell>
                      <span class="text-xs" title={s.cronPattern}>
                        {cronToHuman(s.cronPattern)}
                      </span>
                    </TableCell>
                    <TableCell class="text-xs text-muted-foreground">{s.timeZone}</TableCell>
                    <TableCell>
                      <Switch checked={s.isActive} onChange={() => props.onToggle(s)} disabled={props.updating}>
                        <SwitchControl>
                          <SwitchThumb />
                        </SwitchControl>
                      </Switch>
                    </TableCell>
                    <TableCell class="text-right pr-2">
                      <RowActions
                        disabled={props.triggeredId === s.id}
                        onRun={() => props.onRun(s)}
                        onViewExecutions={() => props.onViewExecutions(s)}
                        onEdit={() => props.onEdit(s)}
                        onDelete={() => props.onDelete(s)}
                      />
                    </TableCell>
                  </TableRow>
                )}
              </For>
            </TableBody>
          </Table>
        </div>
      </Show>
    </>
  );
}

function RowActions(props: {
  disabled?: boolean;
  onRun: () => void;
  onViewExecutions: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        class="inline-flex items-center justify-center rounded-md w-7 h-7 shrink-0 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-50"
        disabled={props.disabled}
        aria-label="Schedule actions"
      >
        <EllipsisVertical class="w-4 h-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem onSelect={() => props.onRun()}>
          <Play class="w-3.5 h-3.5 text-emerald-600" />
          Run now
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => props.onViewExecutions()}>
          <Clock class="w-3.5 h-3.5 text-muted-foreground" />
          View executions
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => props.onEdit()}>
          <Pencil class="w-3.5 h-3.5 text-blue-600" />
          Edit
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          class="text-destructive data-[highlighted]:text-destructive"
          onSelect={() => props.onDelete()}
        >
          <Trash2 class="w-3.5 h-3.5 text-destructive" />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function EditScheduleDialog(props: {
  schedule: Schedule | null;
  onClose: () => void;
  onSave: (dto: UpdateScheduleDto) => void;
}) {
  const [cron, setCron] = createSignal('');

  const open = createMemo(() => !!props.schedule);

  createEffect(() => {
    const s = props.schedule;
    if (s) setCron(s.cronPattern);
  });

  return (
    <Dialog
      open={open()}
      onOpenChange={(o) => {
        if (!o) props.onClose();
      }}
    >
      <DialogContent class="max-w-lg">
        <DialogTitle>Edit Schedule: {props.schedule?.name}</DialogTitle>
        <DialogDescription>Change when this schedule runs</DialogDescription>
        <div class="space-y-3 mt-2">
          <CronPicker cronString={cron()} setCronString={setCron} view="advanced" />
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={props.onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => props.onSave({ cronPattern: cron() })}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ExecutionsDialog(props: {
  schedule: Schedule | null;
  executions: ScheduleExecution[];
  loading: boolean;
  onClose: () => void;
}) {
  const open = createMemo(() => !!props.schedule);

  return (
    <Dialog
      open={open()}
      onOpenChange={(o) => {
        if (!o) props.onClose();
      }}
    >
      <DialogContent class="max-w-lg max-h-[80vh] overflow-y-auto">
        <DialogTitle>Executions: {props.schedule?.name}</DialogTitle>
        <DialogDescription>Recent execution history</DialogDescription>

        <Show when={props.loading}>
          <div class="space-y-2 py-4">
            <Skeleton class="h-4 w-full" />
            <Skeleton class="h-4 w-4/5" />
            <Skeleton class="h-4 w-3/5" />
          </div>
        </Show>

        <Show when={!props.loading && props.executions.length === 0}>
          <p class="text-sm text-muted-foreground py-4">No executions yet.</p>
        </Show>

        <Show when={!props.loading && props.executions.length > 0}>
          <div class="mt-2 space-y-1.5">
            <For each={props.executions}>
              {(exec) => (
                <div class="flex items-center gap-3 text-xs border rounded px-3 py-2">
                  <Badge
                    variant={exec.statusCode && exec.statusCode < 400 ? 'success' : 'destructive'}
                    class="text-[10px] px-1.5"
                  >
                    {exec.statusCode ?? 'ERR'}
                  </Badge>
                  <span class="text-muted-foreground">{exec.trigger}</span>
                  <span class="flex-1 text-muted-foreground">{new Date(exec.firedAt).toLocaleString()}</span>
                  <Show when={exec.latencyMs != null}>
                    <span class="text-muted-foreground">{exec.latencyMs}ms</span>
                  </Show>
                  <Show when={exec.error}>
                    <span class="text-destructive truncate max-w-48" title={exec.error ?? ''}>
                      {exec.error}
                    </span>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </Show>
      </DialogContent>
    </Dialog>
  );
}
