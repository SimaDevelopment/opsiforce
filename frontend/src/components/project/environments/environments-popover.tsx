import { For, Match, Show, Switch, createMemo, createSignal } from 'solid-js';
import { useNavigate } from '@tanstack/solid-router';
import { toast } from 'solid-sonner';
import { usePermissions } from '~/api/permissions';
import { Permission } from '~/constants/permissions';
import { useProjects } from '~/api/projects';
import {
  useDeleteProjectEnvironment,
  useProjectEnvironments,
  useRestartProjectEnvironment,
  type ProjectEnvironment,
} from '~/api/environments';
import { usePublishTargets, type PublishTarget } from '~/api/publish';
import { Popover, PopoverContent, PopoverTrigger } from '~/components/ui/popover';
import { Check, ChevronsUpDown, Layers, LoaderCircle } from '~/components/icons';
import { ConfirmDialog } from '~/components/ui/confirm-dialog';
import { Skeleton } from '~/components/ui/skeleton';
import { ProjectAuthDialog } from '~/components/project-auth-dialog';
import { useJobDock } from '~/components/project/jobs/job-dock-context';
import { EnvManageRow } from './env-manage-row';
import { EnvTargetRow } from './env-target-row';
import { EnvStatusDot } from './env-status-dot';
import { PublishDialog } from './publish-dialog';
import { EnvironmentVariablesDialog } from './environment-variables-dialog';
import { ExternalServicesDialog } from '~/components/external-services/external-services-dialog';

export interface EnvironmentsPopoverProps {
  projectId: string;
  environments: ProjectEnvironment[];
  activeEnvironmentId: string;
  onActiveEnvironmentChange: (environmentId: string) => void;
  onEnvironmentDeleted?: (environmentId: string) => void;
}

export function EnvironmentsPopover(props: EnvironmentsPopoverProps) {
  const { hasPermission } = usePermissions();
  const canManageAuth = () => hasPermission(Permission.manageProjectAuthSettings);
  const canRestart = () => hasPermission(Permission.restartProject);
  const canDelete = () => hasPermission(Permission.deleteEnvironment);
  const canPublish = () => hasPermission(Permission.publishProject);
  const canManageVariables = () => hasPermission(Permission.manageEnvironmentVariables);
  const canSchedules = () => hasPermission(Permission.manageSchedules);
  const canManageExternalServices = () => hasPermission(Permission.manageExternalServices);

  const navigate = useNavigate();
  const [open, setOpen] = createSignal(false);

  const jobDock = useJobDock();
  const publishIndicator = createMemo(() => {
    const jobs = jobDock.entries().filter((entry) => entry.kind === 'publish' && entry.projectId === props.projectId);
    if (jobs.length === 0) return null;
    const statuses = jobs.map((entry) => entry.job?.status);
    if (statuses.some((status) => status !== 'done' && status !== 'failed')) return 'running';
    if (statuses.some((status) => status === 'failed')) return 'failed';
    return 'done';
  });

  const environments = useProjectEnvironments(() => props.projectId, {
    enabled: open,
  });
  const targets = usePublishTargets(() => props.projectId, {
    enabled: () => open() && canPublish(),
  });
  const projects = useProjects({ enabled: open });
  const hasApp = () => projects.data?.find((p) => p.id === props.projectId)?.hasApp === true;

  const restart = useRestartProjectEnvironment();
  const remove = useDeleteProjectEnvironment();

  const [authEnv, setAuthEnv] = createSignal<ProjectEnvironment | null>(null);
  const [variablesEnv, setVariablesEnv] = createSignal<ProjectEnvironment | null>(null);
  const [externalServicesEnv, setExternalServicesEnv] = createSignal<ProjectEnvironment | null>(null);
  const [publishTarget, setPublishTarget] = createSignal<PublishTarget | null>(null);
  const [pendingDelete, setPendingDelete] = createSignal<ProjectEnvironment | null>(null);
  const [pendingRestart, setPendingRestart] = createSignal<ProjectEnvironment | null>(null);
  const [restartingId, setRestartingId] = createSignal<string | null>(null);

  const developmentRow = createMemo(() => environments.data?.find((e) => e.isDefault) ?? null);

  const targetRows = createMemo(() => {
    const instances = environments.data ?? [];
    if (canPublish() && targets.data) {
      return targets.data.map((target) => ({
        target,
        instance: instances.find((i) => i.id === target.projectEnvironmentId) ?? null,
      }));
    }
    return instances.filter((instance) => !instance.isDefault).map((instance) => ({ target: null, instance }));
  });

  const loading = () => environments.isPending || (canPublish() && targets.isPending);

  const activeEnvironment = createMemo(() => props.environments.find((e) => e.id === props.activeEnvironmentId));

  const description = () => {
    const tail = canSchedules() ? ', or open schedules' : '';
    return `Click an environment to view it. Publish the app, manage auth and variables${tail}.`;
  };

  const openSchedules = (env: ProjectEnvironment) => {
    setOpen(false);
    navigate({
      to: '/schedules',
      search: { projectEnvironmentId: env.id, projectId: env.projectId },
    });
  };

  const confirmRestart = () => {
    const env = pendingRestart();
    if (!env) return;
    setRestartingId(env.id);
    restart.mutate(
      { projectId: props.projectId, environmentId: env.id },
      {
        onSuccess: () => toast.success(`Restarting ${env.name}`),
        onError: () => toast.error(`Failed to restart ${env.name}`),
        onSettled: () => setRestartingId(null),
      }
    );
  };

  const confirmDelete = () => {
    const env = pendingDelete();
    if (!env) return;
    remove.mutate(
      { projectId: props.projectId, environmentId: env.id },
      {
        onSuccess: () => {
          toast.success(`${env.name} deleted`);
          props.onEnvironmentDeleted?.(env.id);
        },
        onError: () => toast.error(`Failed to delete ${env.name}`),
      }
    );
  };

  const rowProps = (env: ProjectEnvironment, target: PublishTarget | null) => ({
    environment: env,
    active: env.id === props.activeEnvironmentId,
    onSelect: () => {
      props.onActiveEnvironmentChange(env.id);
      setOpen(false);
    },
    hasApp: hasApp(),
    canManageAuth: canManageAuth(),
    canRestart: canRestart(),
    canDelete: canDelete(),
    canPublish: canPublish() && target !== null,
    canManageVariables: canManageVariables(),
    canSchedules: canSchedules(),
    canManageExternalServices: canManageExternalServices(),
    restarting: restartingId() === env.id,
    onAuth: () => setAuthEnv(env),
    onVariables: () => setVariablesEnv(env),
    onPublish: () => setPublishTarget(target),
    onSchedules: () => openSchedules(env),
    onExternalServices: () => setExternalServicesEnv(env),
    onRestart: () => setPendingRestart(env),
    onDelete: () => setPendingDelete(env),
  });

  return (
    <>
      <Popover open={open()} onOpenChange={setOpen} placement="bottom-start">
        <PopoverTrigger
          class="flex h-8 items-center gap-2 rounded-md border border-input bg-background px-2.5 text-xs transition-colors hover:bg-accent focus:outline-none focus:ring-1 focus:ring-ring"
          aria-label="Environments"
        >
          <Switch fallback={<Layers class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}>
            <Match when={publishIndicator() === 'running'}>
              <LoaderCircle class="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
            </Match>
            <Match when={publishIndicator() === 'failed'}>
              <span class="h-2 w-2 shrink-0 rounded-full bg-destructive" />
            </Match>
            <Match when={publishIndicator() === 'done'}>
              <Check class="h-3.5 w-3.5 shrink-0 text-emerald-500" />
            </Match>
          </Switch>
          <Show when={activeEnvironment()} fallback={<span class="font-medium text-foreground">Environments</span>}>
            {(env) => (
              <span class="flex min-w-0 items-center gap-2">
                <EnvStatusDot status={env().status} />
                <span class="truncate font-medium text-foreground">{env().name}</span>
              </span>
            )}
          </Show>
          <ChevronsUpDown class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </PopoverTrigger>
        <PopoverContent class="w-120 p-0">
          <div class="border-b border-border px-4 pb-3 pt-3.5">
            <p class="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Layers class="h-4 w-4 text-muted-foreground" />
              Environments
            </p>
            <p class="mt-1 text-xs text-muted-foreground">{description()}</p>
          </div>

          <div class="grid max-h-[55vh] grid-cols-[fit-content(12rem)_auto_1fr_auto] gap-x-2 gap-y-0.5 overflow-y-auto p-1.5">
            <Show
              when={!loading()}
              fallback={
                <div class="col-span-full space-y-1.5 p-1">
                  <Skeleton class="h-11 w-full" />
                  <Skeleton class="h-11 w-full" />
                </div>
              }
            >
              <Show when={developmentRow()}>{(env) => <EnvManageRow {...rowProps(env(), null)} />}</Show>
              <For each={targetRows()}>
                {(row) => (
                  <Show
                    when={row.instance}
                    fallback={
                      <Show when={row.target}>
                        {(target) => (
                          <EnvTargetRow
                            target={target()}
                            hasApp={hasApp()}
                            canPublish={canPublish()}
                            onPublish={() => setPublishTarget(target())}
                          />
                        )}
                      </Show>
                    }
                  >
                    {(env) => <EnvManageRow {...rowProps(env(), row.target)} />}
                  </Show>
                )}
              </For>
            </Show>
          </div>
        </PopoverContent>
      </Popover>

      <ProjectAuthDialog
        projectId={props.projectId}
        environmentId={authEnv()?.id ?? ''}
        environmentName={authEnv()?.name}
        open={authEnv() !== null}
        onOpenChange={(value) => {
          if (!value) setAuthEnv(null);
        }}
      />

      <EnvironmentVariablesDialog
        projectId={props.projectId}
        environment={variablesEnv()}
        onOpenChange={(value) => {
          if (!value) setVariablesEnv(null);
        }}
      />

      <ExternalServicesDialog
        environment={externalServicesEnv()}
        onOpenChange={(value) => {
          if (!value) setExternalServicesEnv(null);
        }}
      />

      <Show when={canPublish()}>
        <PublishDialog
          projectId={props.projectId}
          target={publishTarget()}
          open={publishTarget() !== null}
          onOpenChange={(value) => {
            if (!value) setPublishTarget(null);
          }}
        />
      </Show>

      <ConfirmDialog
        open={pendingRestart() !== null}
        onOpenChange={(value) => {
          if (!value) setPendingRestart(null);
        }}
        title="Restart environment"
        description={`Are you sure you want to restart the ${pendingRestart()?.name ?? ''} environment? The running app will briefly go offline while it restarts.`}
        confirmLabel="Restart"
        variant="destructive"
        onConfirm={confirmRestart}
      />

      <ConfirmDialog
        open={pendingDelete() !== null}
        onOpenChange={(value) => {
          if (!value) setPendingDelete(null);
        }}
        title="Delete environment"
        description={`This permanently deletes the ${pendingDelete()?.name ?? ''} environment and its running app. This action cannot be undone.`}
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={confirmDelete}
      />
    </>
  );
}
