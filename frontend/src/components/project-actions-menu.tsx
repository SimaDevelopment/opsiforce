import { For, Show, createMemo, createSignal, type JSX } from 'solid-js';
import { createMutation, useQueryClient } from '@tanstack/solid-query';
import { toast } from 'solid-sonner';
import { usePermissions } from '~/api/permissions';
import { Permission } from '~/constants/permissions';
import { api, type Project } from '~/api/client';
import { startProjectExport, type ExportJob } from '~/api/export';
import { startProjectDuplicate } from '~/api/duplicate';
import { useJobDock } from '~/components/project/jobs/job-dock-context';
import { useRestartProjectEnvironment } from '~/api/environments';
import { PUBLIC_LABEL, useMoveProject, useWorkspaces } from '~/api/workspaces';
import { projectMoveBlockReason } from '~/lib/project-move';
import { projectTitleOf } from '~/lib/project-title';
import {
  ArrowRightLeft,
  Ban,
  ChevronRight,
  CirclePlay,
  Copy,
  FolderKanban,
  Globe,
  Package,
  Pencil,
  RotateCcw,
  Settings,
  Trash2,
} from '~/components/icons';
import {
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '~/components/ui/dropdown-menu';
import { ActionsMenu, ActionsMenuItem } from './actions-menu';
import { ProjectSettings } from './project-settings';
import { ConfirmDialog } from './ui/confirm-dialog';

interface PendingMove {
  toWorkspaceId: string | null;
  toName: string;
}

export function ProjectActionsMenu(props: {
  projectId: string;
  status: Project['status'];
  workspaceId: string | null;
  project?: Project;
  activeEnvironmentId?: string;
  showRename?: boolean;
  onRename?: () => void;
  onSettings?: () => void;
  onDeleted?: () => void;
  extraItems?: JSX.Element;
  deleteDescription?: string;
  deleteEscapeHatch?: (dismiss: () => void) => JSX.Element;
  triggerClass?: string;
  onTriggerClick?: (e: MouseEvent) => void;
}) {
  const qc = useQueryClient();
  const { hasPermission } = usePermissions();
  const jobDock = useJobDock();

  const canSeeSettings = () =>
    hasPermission(Permission.manageProjectBudgetSettings) ||
    hasPermission(Permission.manageProjectTimeoutSettings) ||
    hasPermission(Permission.manageProjectLoggingSettings) ||
    hasPermission(Permission.manageProjectPodSettings);
  const canDisable = () => hasPermission(Permission.disableProject);
  const canRestart = () => hasPermission(Permission.restartProject);
  const canDuplicate = () => hasPermission(Permission.duplicateProject);
  const canDelete = () => hasPermission(Permission.deleteProject);
  const canExport = () => hasPermission(Permission.exportProject);
  const canManageWorkspaces = () => hasPermission(Permission.manageWorkspaces);
  const isDisabled = () => props.status === 'disabled';

  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [confirmAction, setConfirmAction] = createSignal<
    'delete' | 'duplicate' | 'export' | 'disable' | 'restart' | null
  >(null);
  const [pendingMove, setPendingMove] = createSignal<PendingMove | null>(null);

  const workspaces = useWorkspaces();
  const move = useMoveProject();

  const moveTargets = createMemo(() => (workspaces.data ?? []).filter((w) => w.id !== props.workspaceId));

  const currentWorkspaceName = createMemo(() => {
    if (props.workspaceId === null) return PUBLIC_LABEL;
    return (workspaces.data ?? []).find((w) => w.id === props.workspaceId)?.name ?? 'workspace';
  });

  const kind = () => props.project?.kind;
  const kindKnown = () => kind() !== undefined;
  const isBuilderChat = () => kind() === 'skill_builder_chat' || kind() === 'agent_builder_chat';
  const showMove = () =>
    kind() === null && (moveTargets().length > 0 || (canManageWorkspaces() && props.workspaceId !== null));
  const showDuplicate = () => canDuplicate() && kind() === null;
  const showExport = () => canExport() && kind() === null;

  const projectTitle = () => projectTitleOf(props.project);

  const requestMove = (move: PendingMove) => {
    const blockReason = projectMoveBlockReason({
      workspaces: workspaces.data ?? [],
      fromWorkspaceId: props.workspaceId,
      toWorkspaceId: move.toWorkspaceId,
    });
    if (blockReason) {
      toast.error(blockReason);
      return;
    }
    setPendingMove(move);
  };

  const confirmMove = () => {
    const target = pendingMove();
    if (!target) return;
    move.mutate({
      projectId: props.projectId,
      fromWorkspaceId: props.workspaceId,
      toWorkspaceId: target.toWorkspaceId,
      fromName: currentWorkspaceName(),
      toName: target.toName,
    });
  };

  const deleteProject = createMutation(() => ({
    mutationFn: () => api.delete<void>(`/projects/${props.projectId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['projects'] });
      props.onDeleted?.();
    },
  }));

  const duplicateProject = createMutation(() => ({
    mutationFn: () => startProjectDuplicate(props.projectId),
    onSuccess: (p: Project) => {
      qc.invalidateQueries({ queryKey: ['projects'] });
      jobDock.trackDuplicate({ projectId: p.id, title: p.title?.trim() || projectTitle() });
    },
    onError: () => toast.error('Failed to duplicate project'),
  }));

  const exportProject = createMutation(() => ({
    mutationFn: () => startProjectExport(props.projectId),
    onSuccess: (job: ExportJob) => {
      jobDock.trackExport({ projectId: props.projectId, title: projectTitle(), job });
    },
    onError: () => toast.error('Failed to start export'),
  }));

  const disableProject = createMutation(() => ({
    mutationFn: () => api.post<Project>(`/projects/${props.projectId}/disable`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['projects'] }),
  }));

  const enableProject = createMutation(() => ({
    mutationFn: () => api.post<Project>(`/projects/${props.projectId}/enable`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['projects'] }),
  }));

  const restartProject = createMutation(() => ({
    mutationFn: () => api.post<Project>(`/projects/${props.projectId}/restart`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['projects'] });
      qc.refetchQueries({ queryKey: ['projects', props.projectId] });
    },
  }));

  const restartEnvironment = useRestartProjectEnvironment();

  const isDevelopmentActive = () => !props.activeEnvironmentId || props.activeEnvironmentId === props.projectId;

  const handleRestart = () => {
    if (isDevelopmentActive()) {
      restartProject.mutate(undefined as never);
      return;
    }
    const environmentId = props.activeEnvironmentId;
    if (!environmentId) return;
    restartEnvironment.mutate({ projectId: props.projectId, environmentId });
  };

  return (
    <>
      <ActionsMenu label="Project actions" triggerClass={props.triggerClass} onTriggerClick={props.onTriggerClick}>
        {props.extraItems}
        <Show when={props.showRename && props.onRename}>
          <ActionsMenuItem icon={Pencil} onSelect={() => props.onRename?.()}>
            Rename
          </ActionsMenuItem>
        </Show>
        <Show when={showDuplicate()}>
          <ActionsMenuItem icon={Copy} onSelect={() => setConfirmAction('duplicate')}>
            Duplicate
          </ActionsMenuItem>
        </Show>
        <Show when={showExport()}>
          <ActionsMenuItem icon={Package} onSelect={() => setConfirmAction('export')}>
            Export
          </ActionsMenuItem>
        </Show>
        <Show when={canRestart() && !isDisabled()}>
          <ActionsMenuItem icon={RotateCcw} onSelect={() => setConfirmAction('restart')}>
            Restart
          </ActionsMenuItem>
        </Show>
        <Show when={canDisable() && (isDisabled() || (kindKnown() && !isBuilderChat()))}>
          <Show
            when={isDisabled()}
            fallback={
              <ActionsMenuItem icon={Ban} onSelect={() => setConfirmAction('disable')}>
                Disable
              </ActionsMenuItem>
            }
          >
            <ActionsMenuItem icon={CirclePlay} onSelect={() => enableProject.mutate(undefined as never)}>
              Enable
            </ActionsMenuItem>
          </Show>
        </Show>
        <Show when={canSeeSettings()}>
          <ActionsMenuItem
            icon={Settings}
            onSelect={() => {
              if (props.onSettings) props.onSettings();
              else setSettingsOpen(true);
            }}
          >
            Settings
          </ActionsMenuItem>
        </Show>
        <Show when={showMove()}>
          <DropdownMenuSeparator />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <ArrowRightLeft class="w-3.5 h-3.5 text-muted-foreground" />
              Move to
              <ChevronRight class="ml-auto w-3.5 h-3.5 text-muted-foreground" />
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <For each={moveTargets()}>
                {(ws) => (
                  <ActionsMenuItem
                    icon={FolderKanban}
                    onSelect={() => requestMove({ toWorkspaceId: ws.id, toName: ws.name })}
                  >
                    {ws.name}
                  </ActionsMenuItem>
                )}
              </For>
              <Show when={canManageWorkspaces() && props.workspaceId !== null}>
                <Show when={moveTargets().length > 0}>
                  <DropdownMenuSeparator />
                </Show>
                <ActionsMenuItem
                  icon={Globe}
                  onSelect={() => requestMove({ toWorkspaceId: null, toName: PUBLIC_LABEL })}
                >
                  {PUBLIC_LABEL}
                </ActionsMenuItem>
              </Show>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </Show>
        <Show when={canDelete() && kindKnown() && !isBuilderChat()}>
          <DropdownMenuSeparator />
          <ActionsMenuItem icon={Trash2} destructive onSelect={() => setConfirmAction('delete')}>
            Delete
          </ActionsMenuItem>
        </Show>
      </ActionsMenu>

      <Show when={!props.onSettings}>
        <ProjectSettings
          projectId={props.projectId}
          activeEnvironmentId={props.activeEnvironmentId}
          open={settingsOpen()}
          onOpenChange={setSettingsOpen}
        />
      </Show>

      <ConfirmDialog
        open={pendingMove() !== null}
        onOpenChange={(open) => {
          if (!open) setPendingMove(null);
        }}
        title="Move project"
        description={
          pendingMove() ? `Move "${projectTitle()}" from ${currentWorkspaceName()} to ${pendingMove()?.toName}?` : ''
        }
        confirmLabel="Move"
        onConfirm={confirmMove}
      />

      <ConfirmDialog
        open={confirmAction() === 'delete'}
        onOpenChange={(open) => {
          if (!open) setConfirmAction(null);
        }}
        title="Delete project"
        description={
          props.deleteDescription ??
          'This will permanently delete the project and all its data. This action cannot be undone.'
        }
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={() => deleteProject.mutate(undefined as never)}
      >
        {props.deleteEscapeHatch?.(() => setConfirmAction(null))}
      </ConfirmDialog>

      <ConfirmDialog
        open={confirmAction() === 'disable'}
        onOpenChange={(open) => {
          if (!open) setConfirmAction(null);
        }}
        title="Disable project"
        description="This will shut down the project. The project data will be preserved and the project can be re-enabled later."
        confirmLabel="Disable"
        variant="destructive"
        onConfirm={() => disableProject.mutate(undefined as never)}
      />

      <ConfirmDialog
        open={confirmAction() === 'duplicate'}
        onOpenChange={(open) => {
          if (!open) setConfirmAction(null);
        }}
        title="Duplicate project"
        description="This will create a copy of the project with the same workspace files."
        confirmLabel="Duplicate"
        onConfirm={() => duplicateProject.mutate(undefined as never)}
      />

      <ConfirmDialog
        open={confirmAction() === 'export'}
        onOpenChange={(open) => {
          if (!open) setConfirmAction(null);
        }}
        title="Export project"
        description="This exports the project's Development environment to a downloadable file. The file contains live environment variable values and the full conversation — treat it as sensitive and share it carefully."
        confirmLabel="Export"
        onConfirm={() => exportProject.mutate(undefined as never)}
      />

      <ConfirmDialog
        open={confirmAction() === 'restart'}
        onOpenChange={(open) => {
          if (!open) setConfirmAction(null);
        }}
        title="Restart project"
        description="Are you sure you want to restart this project? Project data will be preserved."
        confirmLabel="Restart"
        variant="destructive"
        onConfirm={handleRestart}
      />
    </>
  );
}
