import { For, Show, createMemo, createSignal } from 'solid-js';
import { useMatch, useNavigate } from '@tanstack/solid-router';
import { DragDropProvider, type DragDropProviderProps } from '@dnd-kit/solid';
import { isSortable } from '@dnd-kit/solid/sortable';
import { useQueryClient } from '@tanstack/solid-query';
import { toast } from 'solid-sonner';
import { type Folder, type Project } from '~/api/client';
import { limitRefusalMessage } from '~/api/limits';
import { usePermissions } from '~/api/permissions';
import { useAgents } from '~/api/agents';
import { useAgentStatusStream } from '~/api/agent-status';
import { useCreateUnassignedProject, useProjects, useRenameProject } from '~/api/projects';
import { usePrivateWorkspacesDisabled } from '~/api/default-project-target';
import {
  PUBLIC_LABEL,
  useCreateProjectInWorkspace,
  useMoveFolder,
  useMoveProject,
  useMoveProjectToFolder,
  useWorkspaces,
  workspaceKeys,
} from '~/api/workspaces';
import { useUpdateWorkspacePreferences } from '~/api/users';
import { createPersistedSignal } from '~/lib/persisted-signal';
import { projectMoveBlockReason } from '~/lib/project-move';
import {
  DndType,
  type FolderDragData,
  type Placement,
  PUBLIC_ID,
  dropGroupId,
  parseGroupId,
  readDropWorkspaceId,
  setActiveDragType,
  toFolderDragData,
  toProjectDragData,
} from '~/lib/sidebar-dnd';
import { Permission } from '~/constants/permissions';
import { Boxes } from '~/components/icons';
import { Spinner } from '~/components/ui/spinner';
import { ConfirmDialog } from '~/components/ui/confirm-dialog';
import { ProjectSettings } from '../project-settings';
import { WorkspaceSettings } from '../workspace-settings';
import { FolderDialog } from '~/components/folder-dialog';
import { SidebarWorkspaceGroup } from './sidebar-workspace-group';
import { SidebarPublicGroup } from './sidebar-public-group';
import { CreateMenu } from './create-menu';
import { ProjectImportDialog } from '~/components/project/project-import-dialog';

const FOLDED_KEY = 'opsiforce:workspace:folded';
const PUBLIC_FOLDED_KEY = 'opsiforce:workspace:public-folded';
const FOLDER_EXPANDED_KEY = 'opsiforce:folder:expanded';

type DragStartEvent = Parameters<NonNullable<DragDropProviderProps['onDragStart']>>[0];
type DragEndEvent = Parameters<NonNullable<DragDropProviderProps['onDragEnd']>>[0];

interface PendingMove {
  projectId: string;
  fromWorkspaceId: string | null;
  toWorkspaceId: string | null;
  toFolderId: string | null;
  fromName: string;
  toName: string;
  toFolderName: string | null;
  projectTitle: string;
}

const moveDescription = (move: PendingMove): string => {
  const destination = move.toFolderName ? `${move.toName} / ${move.toFolderName}` : move.toName;
  return `Move "${move.projectTitle}" from ${move.fromName} to ${destination}?`;
};

interface PendingFolderMove {
  folderId: string;
  fromWorkspaceId: string;
  toWorkspaceId: string;
  fromName: string;
  toName: string;
  folderName: string;
}

const folderMoveDescription = (move: PendingFolderMove): string =>
  `Move folder "${move.folderName}" and its projects from ${move.fromName} to ${move.toName}?`;

const onDragStart = (event: DragStartEvent) => {
  const type = event.operation.source?.type;
  setActiveDragType(typeof type === 'string' ? (type as DndType) : null);
};

export function ProjectSidebar(props: { search: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { hasPermission } = usePermissions();

  const privateWorkspacesDisabled = usePrivateWorkspacesDisabled();

  const canManageWorkspaces = () => hasPermission(Permission.manageWorkspaces);
  const canImport = () => hasPermission(Permission.importProject);
  const canCreateInPublic = () => canManageWorkspaces() || privateWorkspacesDisabled();

  const projectMatch = useMatch({ from: '/projects/$projectId', shouldThrow: false });
  const activeProjectId = () => projectMatch()?.params.projectId;

  const [settingsProjectId, setSettingsProjectId] = createSignal<string | null>(null);
  const [settingsWorkspaceId, setSettingsWorkspaceId] = createSignal<string | null>(null);
  const [pendingMove, setPendingMove] = createSignal<PendingMove | null>(null);
  const [pendingFolderMove, setPendingFolderMove] = createSignal<PendingFolderMove | null>(null);
  const [importTarget, setImportTarget] = createSignal<{
    workspaceId: string | null;
    folder?: { id: string; name: string };
  } | null>(null);

  const projects = useProjects();
  useAgentStatusStream(() => projects.data);
  const workspaces = useWorkspaces();
  const agents = useAgents();
  const updatePrefs = useUpdateWorkspacePreferences();
  const createInWs = useCreateProjectInWorkspace();
  const createUnassigned = useCreateUnassignedProject();
  const moveProject = useMoveProject();
  const moveToFolder = useMoveProjectToFolder();
  const moveFolder = useMoveFolder();
  const renameProject = useRenameProject();

  const [folded, setFolded] = createPersistedSignal<Record<string, boolean>>(FOLDED_KEY, {});
  const [publicFolded, setPublicFolded] = createPersistedSignal<boolean>(PUBLIC_FOLDED_KEY, false);
  const [folderExpanded, setFolderExpanded] = createPersistedSignal<Record<string, boolean>>(FOLDER_EXPANDED_KEY, {});
  const [createFolderWorkspaceId, setCreateFolderWorkspaceId] = createSignal<string | null>(null);

  const isFolderExpanded = (id: string) => !!folderExpanded()[id];
  const toggleFolder = (id: string) => setFolderExpanded((prev) => ({ ...prev, [id]: !prev[id] }));

  const toggleFold = (id: string) => {
    if (id === PUBLIC_ID) {
      setPublicFolded(!publicFolded());
      return;
    }
    setFolded((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const isFolded = (id: string) => (id === PUBLIC_ID ? publicFolded() : !!folded()[id]);

  const groupedProjects = createMemo(() => {
    const byWs = new Map<string, Project[]>();
    const publicProjects: Project[] = [];
    for (const p of projects.data ?? []) {
      if (p.workspaceId) {
        const arr = byWs.get(p.workspaceId) ?? [];
        arr.push(p);
        byWs.set(p.workspaceId, arr);
      } else {
        publicProjects.push(p);
      }
    }
    return { byWs, publicProjects };
  });

  const searchQuery = () => props.search.toLowerCase().trim();

  const filterByQuery = (list: Project[]) => {
    const q = searchQuery();
    if (!q) return list;
    return list.filter((p) => (p.title ?? '').toLowerCase().includes(q));
  };

  const workspaceLabel = (id: string | null): string => {
    if (id === null) return PUBLIC_LABEL;
    return (workspaces.data ?? []).find((w) => w.id === id)?.name ?? 'workspace';
  };

  const folderLabel = (workspaceId: string, folderId: string): string | null => {
    const folders = queryClient.getQueryData<Folder[]>(workspaceKeys.folders(workspaceId));
    return folders?.find((f) => f.id === folderId)?.name ?? null;
  };

  const reorderWorkspacesByIndex = (fromIdx: number, toIdx: number) => {
    const current = (workspaces.data ?? []).map((w) => w.id);
    if (fromIdx < 0 || toIdx < 0 || fromIdx >= current.length || fromIdx === toIdx) return;
    const next = [...current];
    const [moved] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, moved);
    updatePrefs.mutate({ workspaceOrder: next });
  };

  const navigateToProject = (projectId: string) =>
    navigate({
      to: '/projects/$projectId',
      params: { projectId },
      search: { prompt: undefined, promptId: undefined },
    });

  const handleCreateInWorkspace = async (workspaceId: string, agentId?: string, folderId?: string) => {
    try {
      const project = await createInWs.mutateAsync({ workspaceId, folderId, dto: agentId ? { agentId } : undefined });
      if (folderId) setFolderExpanded((prev) => ({ ...prev, [folderId]: true }));
      toast.success('Project created');
      navigateToProject(project.id);
    } catch (err) {
      toast.error(limitRefusalMessage(err, 'Failed to create project'));
    }
  };

  const handleCreateUnassigned = (agentId?: string) =>
    createUnassigned.mutate(agentId ? { agentId } : undefined, {
      onSuccess: (project) => {
        toast.success('Project created');
        navigateToProject(project.id);
      },
      onError: (err) => toast.error(limitRefusalMessage(err, 'Failed to create project')),
    });

  const handleWorkspaceReorder = (initialIndex: number, index: number) => {
    if (initialIndex === index) return;
    reorderWorkspacesByIndex(initialIndex, index);
  };

  const handleProjectMove = (projectId: string, toGroupId: string | undefined) => {
    if (!toGroupId) return;
    const project = (projects.data ?? []).find((p) => p.id === projectId);
    if (!project) return;
    const from: Placement = { workspaceId: project.workspaceId ?? null, folderId: project.folderId ?? null };
    const to = parseGroupId(toGroupId);

    if (to.workspaceId === from.workspaceId) {
      if (to.workspaceId === null || from.folderId === to.folderId) return;
      moveToFolder.mutate({ workspaceId: to.workspaceId, projectId, folderId: to.folderId });
      return;
    }

    const blockReason = projectMoveBlockReason({
      workspaces: workspaces.data ?? [],
      fromWorkspaceId: from.workspaceId,
      toWorkspaceId: to.workspaceId,
    });
    if (blockReason) {
      toast.error(blockReason);
      return;
    }
    setPendingMove({
      projectId,
      fromWorkspaceId: from.workspaceId,
      toWorkspaceId: to.workspaceId,
      toFolderId: to.folderId,
      fromName: workspaceLabel(from.workspaceId),
      toName: workspaceLabel(to.workspaceId),
      toFolderName: to.workspaceId && to.folderId ? folderLabel(to.workspaceId, to.folderId) : null,
      projectTitle: project.title?.trim() || 'Untitled project',
    });
  };

  const confirmMove = () => {
    const move = pendingMove();
    if (!move) return;
    moveProject.mutate({
      projectId: move.projectId,
      fromWorkspaceId: move.fromWorkspaceId,
      toWorkspaceId: move.toWorkspaceId,
      toFolderId: move.toFolderId,
      fromName: move.fromName,
      toName: move.toName,
    });
  };

  const handleFolderMove = (folder: FolderDragData, toWorkspaceId: string | undefined) => {
    if (!toWorkspaceId || toWorkspaceId === folder.workspaceId) return;
    setPendingFolderMove({
      folderId: folder.folderId,
      fromWorkspaceId: folder.workspaceId,
      toWorkspaceId,
      fromName: workspaceLabel(folder.workspaceId),
      toName: workspaceLabel(toWorkspaceId),
      folderName: folder.folderName,
    });
  };

  const confirmFolderMove = () => {
    const move = pendingFolderMove();
    if (!move) return;
    moveFolder.mutate({
      folderId: move.folderId,
      fromWorkspaceId: move.fromWorkspaceId,
      toWorkspaceId: move.toWorkspaceId,
      fromName: move.fromName,
      toName: move.toName,
    });
  };

  const onDragEnd = (event: DragEndEvent) => {
    setActiveDragType(null);
    if (event.canceled) return;
    const { source, target } = event.operation;
    if (!source) return;

    if (source.type === DndType.Folder) {
      const folder = toFolderDragData(source.data);
      if (folder) handleFolderMove(folder, target ? readDropWorkspaceId(target.data) : undefined);
      return;
    }

    if (source.type === DndType.Project) {
      const project = toProjectDragData(source.data);
      if (project) handleProjectMove(project.projectId, dropGroupId(target));
      return;
    }

    if (source.type === DndType.Workspace && isSortable(source)) {
      handleWorkspaceReorder(source.initialIndex, source.index);
    }
  };

  return (
    <>
      <Show
        when={workspaces.data && projects.data}
        fallback={
          <div class="py-10">
            <Spinner size="sm" />
          </div>
        }
      >
        <DragDropProvider onDragStart={onDragStart} onDragEnd={onDragEnd}>
          <div class="flex flex-col gap-1">
            <For each={workspaces.data}>
              {(ws, idx) => (
                <SidebarWorkspaceGroup
                  workspace={ws}
                  index={idx()}
                  folded={isFolded(ws.id)}
                  search={props.search}
                  projects={groupedProjects().byWs.get(ws.id) ?? []}
                  activeProjectId={activeProjectId()}
                  isFolderExpanded={isFolderExpanded}
                  onToggleFolder={toggleFolder}
                  onToggleFold={() => toggleFold(ws.id)}
                  onOpenSettings={
                    ws.type !== 'private' && canManageWorkspaces() ? () => setSettingsWorkspaceId(ws.id) : undefined
                  }
                  renderCreate={(renderTrigger) => (
                    <CreateMenu
                      trigger={renderTrigger}
                      agents={agents.data}
                      disabled={createInWs.isPending}
                      canImport={canImport()}
                      onCreateProject={(agentId) => handleCreateInWorkspace(ws.id, agentId)}
                      onOpenCreateFolder={() => setCreateFolderWorkspaceId(ws.id)}
                      onOpenImport={() => setImportTarget({ workspaceId: ws.id })}
                    />
                  )}
                  renderFolderCreate={(folder) => (renderTrigger) => (
                    <CreateMenu
                      trigger={renderTrigger}
                      agents={agents.data}
                      disabled={createInWs.isPending}
                      canImport={canImport()}
                      onCreateProject={(agentId) => handleCreateInWorkspace(ws.id, agentId, folder.id)}
                      onOpenImport={() =>
                        setImportTarget({ workspaceId: ws.id, folder: { id: folder.id, name: folder.name } })
                      }
                    />
                  )}
                  onSelectProject={navigateToProject}
                  onRenameProject={(id, title) => renameProject.mutate({ id, title })}
                  onProjectSettings={(id) => setSettingsProjectId(id)}
                  onProjectDeleted={(id) => {
                    if (id === activeProjectId()) navigate({ to: '/' });
                  }}
                />
              )}
            </For>

            <SidebarPublicGroup
              expanded={!isFolded(PUBLIC_ID)}
              projects={filterByQuery(groupedProjects().publicProjects)}
              activeProjectId={activeProjectId()}
              onToggleFold={() => toggleFold(PUBLIC_ID)}
              renderCreate={
                canCreateInPublic() || canImport()
                  ? (renderTrigger) => (
                      <CreateMenu
                        trigger={renderTrigger}
                        agents={agents.data}
                        disabled={createUnassigned.isPending}
                        canCreateProject={canCreateInPublic()}
                        canImport={canImport()}
                        onCreateProject={(agentId) => handleCreateUnassigned(agentId)}
                        onOpenImport={() => setImportTarget({ workspaceId: null })}
                      />
                    )
                  : undefined
              }
              onSelectProject={navigateToProject}
              onRenameProject={(id, title) => renameProject.mutate({ id, title })}
              onProjectSettings={(id) => setSettingsProjectId(id)}
              onProjectDeleted={(id) => {
                if (id === activeProjectId()) navigate({ to: '/' });
              }}
            />

            <Show when={(workspaces.data?.length ?? 0) === 0 && (projects.data?.length ?? 0) === 0}>
              <div class="flex flex-col items-center justify-center py-8 px-4 text-center">
                <Boxes class="w-10 h-10 text-muted-foreground/30 mb-3" stroke-width="1" />
                <p class="text-xs text-muted-foreground">No workspaces or projects yet</p>
                <Show
                  when={canManageWorkspaces()}
                  fallback={
                    <p class="text-xs text-muted-foreground/60 mt-0.5">
                      Projects appear here once you're added to a workspace.
                    </p>
                  }
                >
                  <p class="text-xs text-muted-foreground/60 mt-0.5">
                    Create a workspace from settings to get started.
                  </p>
                </Show>
              </div>
            </Show>
          </div>
        </DragDropProvider>
      </Show>

      <Show when={settingsProjectId()}>
        {(id) => (
          <ProjectSettings
            projectId={id()}
            open={true}
            onOpenChange={(open) => {
              if (!open) setSettingsProjectId(null);
            }}
          />
        )}
      </Show>

      <Show when={settingsWorkspaceId()}>
        {(id) => (
          <WorkspaceSettings
            workspaceId={id()}
            open={true}
            onOpenChange={(open) => {
              if (!open) setSettingsWorkspaceId(null);
            }}
          />
        )}
      </Show>

      <Show when={createFolderWorkspaceId()}>
        {(workspaceId) => (
          <FolderDialog
            workspaceId={workspaceId()}
            open={true}
            onOpenChange={(open) => {
              if (!open) setCreateFolderWorkspaceId(null);
            }}
            onSaved={(folder) => {
              setFolderExpanded((prev) => ({ ...prev, [folder.id]: true }));
              setFolded((prev) => ({ ...prev, [folder.workspaceId]: false }));
            }}
          />
        )}
      </Show>

      <ConfirmDialog
        open={!!pendingMove()}
        onOpenChange={(open) => {
          if (!open) setPendingMove(null);
        }}
        title="Move project"
        description={(() => {
          const move = pendingMove();
          return move ? moveDescription(move) : '';
        })()}
        confirmLabel="Move"
        onConfirm={confirmMove}
      />

      <ConfirmDialog
        open={!!pendingFolderMove()}
        onOpenChange={(open) => {
          if (!open) setPendingFolderMove(null);
        }}
        title="Move folder"
        description={(() => {
          const move = pendingFolderMove();
          return move ? folderMoveDescription(move) : '';
        })()}
        confirmLabel="Move"
        onConfirm={confirmFolderMove}
      />

      <ProjectImportDialog
        open={!!importTarget()}
        defaultWorkspaceId={importTarget()?.workspaceId ?? null}
        defaultFolder={importTarget()?.folder ?? null}
        onOpenChange={(open) => {
          if (!open) setImportTarget(null);
        }}
      />
    </>
  );
}
