import { For, Match, Show, Switch, createMemo, createSignal } from 'solid-js';
import { useNavigate } from '@tanstack/solid-router';
import { toast } from '~/lib/toast';
import { usePermissions } from '~/api/permissions';
import { useProjects } from '~/api/projects';
import {
  useEnvironments,
  useDeleteProjectEnvironment,
  useProjectEnvironments,
  useRestartProjectEnvironment,
  useRotateGatewayKey,
  type ProjectEnvironment,
} from '~/api/environments';
import { usePublishTargets, type PublishTarget } from '~/api/publish';
import { useCustomDomainsOffered } from '~/api/custom-domains';
import { Popover, PopoverContent, PopoverTrigger } from '~/components/ui/popover';
import { useSidebar } from '~/components/ui/sidebar';
import { deriveEnvironmentShortName } from '~/lib/environment-label';
import { Check, ChevronsUpDown, Layers, LoaderCircle, Upload } from '~/components/icons';
import { ConfirmDialog } from '~/components/ui/confirm-dialog';
import { Skeleton } from '~/components/ui/skeleton';
import { ProjectAuthDialog } from '~/components/project-auth-dialog';
import { useJobDock } from '~/components/project/jobs/job-dock-context';
import { EnvManageRow } from './env-manage-row';
import { EnvTargetRow } from './env-target-row';
import { EnvStatusDot } from './env-status-dot';
import { PublishDialog } from './publish-dialog';
import { EnvironmentVariablesDialog } from './environment-variables-dialog';
import { EditAppUrlDialog } from '../edit-app-url-dialog';
import { DomainsDialog } from '../custom-domains/domains-dialog';

export interface EnvironmentsPopoverProps {
  projectId: string;
  /**
   * Surfaces Publish as a primary action beside the switcher. The band asks
   * for it: publishing is the point of the screen, and it was reachable only
   * from inside this popover's rows.
   */
  showPublishButton?: boolean;
  environments: ProjectEnvironment[];
  activeEnvironmentId: string;
  onActiveEnvironmentChange: (environmentId: string) => void;
  onEnvironmentDeleted?: (environmentId: string) => void;
}

export function EnvironmentsPopover(props: EnvironmentsPopoverProps) {
  const { hasPermission } = usePermissions();
  const canManageAuth = () => hasPermission('can_manage_project_auth_settings');
  const canRestart = () => hasPermission('can_restart_project');
  const canDelete = () => hasPermission('can_delete_environment');
  const canPublish = () => hasPermission('can_publish_project');
  const canManageVariables = () => hasPermission('can_manage_environment_variables');
  const canSchedules = () => hasPermission('can_manage_schedules');
  const canEditAppDetails = () => hasPermission('can_edit_app_details');
  const customDomainsOffered = useCustomDomainsOffered();

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
  // Targets were fetched only while the popover was open. The band's Publish
  // button has to know whether there is anywhere to publish to before anyone
  // opens anything, so it widens the gate when it is on.
  const targets = usePublishTargets(() => props.projectId, {
    enabled: () => (open() || props.showPublishButton === true) && canPublish(),
  });
  // hasApp gates every Publish action, so the band button needs it too
  const projects = useProjects({ enabled: () => open() || props.showPublishButton === true });
  const hasApp = () => projects.data?.find((p) => p.id === props.projectId)?.hasApp === true;

  const restart = useRestartProjectEnvironment();
  const remove = useDeleteProjectEnvironment();
  const rotateGatewayKey = useRotateGatewayKey();

  const [authEnv, setAuthEnv] = createSignal<ProjectEnvironment | null>(null);
  const [variablesEnv, setVariablesEnv] = createSignal<ProjectEnvironment | null>(null);
  const [editUrlEnv, setEditUrlEnv] = createSignal<ProjectEnvironment | null>(null);
  const [domainsEnv, setDomainsEnv] = createSignal<ProjectEnvironment | null>(null);
  const [publishTarget, setPublishTarget] = createSignal<PublishTarget | null>(null);
  const [pendingDelete, setPendingDelete] = createSignal<ProjectEnvironment | null>(null);
  const [pendingRestart, setPendingRestart] = createSignal<ProjectEnvironment | null>(null);
  const [restartingId, setRestartingId] = createSignal<string | null>(null);
  const [pendingRotate, setPendingRotate] = createSignal<ProjectEnvironment | null>(null);

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
  // On a phone the band has room for the environment's Badge Label (Dev, Prod),
  // not its name: the name would push the project's title off the band.
  const sidebar = useSidebar();
  const registry = useEnvironments({ enabled: () => sidebar.isMobile() });
  const triggerLabel = (env: ProjectEnvironment) => {
    if (!sidebar.isMobile()) return env.name;
    const registered = registry.data?.find((e) => e.id === env.environmentId);
    // capitalised, not uppercased: here the Badge Label stands in for the name
    const short = registered?.shortName?.trim() || deriveEnvironmentShortName(env.slug ?? registered?.slug ?? env.name);
    return short.charAt(0).toUpperCase() + short.slice(1).toLowerCase();
  };

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

  const confirmRotate = () => {
    const env = pendingRotate();
    if (!env) return;
    rotateGatewayKey.mutate(
      { projectId: props.projectId, environmentId: env.id },
      {
        onSuccess: () => toast.success(`Rotated the Gateway Key of ${env.name}`),
        onError: () => toast.error(`Failed to rotate the Gateway Key of ${env.name}`),
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
    canEditAppDetails: canEditAppDetails(),
    customDomainsOffered: customDomainsOffered(),
    restarting: restartingId() === env.id,
    onAuth: () => setAuthEnv(env),
    onVariables: () => setVariablesEnv(env),
    onEditUrl: () => setEditUrlEnv(env),
    onDomains: () => setDomainsEnv(env),
    onPublish: () => setPublishTarget(target),
    onSchedules: () => openSchedules(env),
    onRestart: () => setPendingRestart(env),
    onRotateGatewayKey: () => setPendingRotate(env),
    onDelete: () => setPendingDelete(env),
  });

  // One publishable target publishes straight away; several means the choice
  // is the user's, so the switcher opens instead of guessing.
  const publishable = () => (targets.data ?? []).filter((t) => t !== null);
  const startPublish = () => {
    if (!hasApp()) return;
    const list = publishable();
    if (canPublish() && list.length === 1) setPublishTarget(list[0]);
    else setOpen(true);
  };

  return (
    <>
      <Popover open={open()} onOpenChange={setOpen} placement="bottom-start">
        {/* a pill with its status dot, not a bordered select */}
        <PopoverTrigger class="of-chip of-chip-btn fr" aria-label="Environments">
          <Switch fallback={<Layers class="h-3.5 w-3.5 shrink-0 text-muted-foreground max-md:hidden" />}>
            <Match when={publishIndicator() === 'running'}>
              <LoaderCircle class="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
            </Match>
            <Match when={publishIndicator() === 'failed'}>
              <span class="h-2 w-2 shrink-0 rounded-full bg-destructive" />
            </Match>
            <Match when={publishIndicator() === 'done'}>
              <Check class="of-ink of-tone-done h-3.5 w-3.5 shrink-0" />
            </Match>
          </Switch>
          <Show when={activeEnvironment()} fallback={<span class="font-medium text-foreground">Environments</span>}>
            {(env) => (
              <span class="flex min-w-0 items-center gap-2">
                <EnvStatusDot status={env().status} />
                <span class="truncate font-medium text-foreground" title={env().name}>
                  {triggerLabel(env())}
                </span>
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
      <Show when={props.showPublishButton && canPublish() && hasApp() && publishable().length > 0}>
        <button type="button" class="of-btn of-btn-primary of-btn-compact fr" onClick={startPublish}>
          <Upload class="h-3.5 w-3.5" />
          Publish
        </button>
      </Show>

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

      <EditAppUrlDialog
        projectId={props.projectId}
        environment={editUrlEnv()}
        onOpenChange={(value) => {
          if (!value) setEditUrlEnv(null);
        }}
      />

      <DomainsDialog
        projectId={props.projectId}
        environment={domainsEnv()}
        onOpenChange={(value) => {
          if (!value) setDomainsEnv(null);
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
        open={pendingRotate() !== null}
        onOpenChange={(value) => {
          if (!value) setPendingRotate(null);
        }}
        title="Rotate Gateway Key"
        description={`The ${pendingRotate()?.name ?? ''} environment gets a new Gateway Key and the old one stops working at once. Its pod restarts with the new key, so the running app and agent briefly go offline.`}
        confirmLabel="Rotate"
        variant="destructive"
        onConfirm={confirmRotate}
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
