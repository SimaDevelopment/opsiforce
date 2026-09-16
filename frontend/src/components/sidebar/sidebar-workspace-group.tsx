import { For, Show, createMemo, type JSX } from 'solid-js';
import { useSortable } from '@dnd-kit/solid/sortable';
import { useDroppable } from '@dnd-kit/solid';
import { type Folder, type Project, type Workspace } from '~/api/client';
import { useWorkspaceFolders } from '~/api/workspaces';
import { DndType, DROP_ZONE_PRIORITY, folderMoveTargetId } from '~/lib/sidebar-dnd';
import { SidebarDropZone } from './sidebar-drop-zone';
import { Boxes, ChevronDown, ChevronRight, GripVertical, Lock, Settings } from '~/components/icons';
import { SidebarDraggableProjectRow } from './sidebar-draggable-project-row';
import { SidebarFolderGroup } from './sidebar-folder-group';
import { SidebarCreateButton } from './sidebar-create-button';

export function SidebarWorkspaceGroup(props: {
  workspace: Workspace;
  index: number;
  folded: boolean;
  search: string;
  projects: Project[];
  activeProjectId: string | undefined;
  isFolderExpanded: (folderId: string) => boolean;
  onToggleFolder: (folderId: string) => void;
  onToggleFold: () => void;
  onOpenSettings?: () => void;
  renderCreate: (renderTrigger: (triggerProps: Record<string, unknown>) => JSX.Element) => JSX.Element;
  renderFolderCreate: (
    folder: Folder
  ) => (renderTrigger: (triggerProps: Record<string, unknown>) => JSX.Element) => JSX.Element;
  onSelectProject: (id: string) => void;
  onRenameProject: (id: string, title: string) => void;
  onProjectSettings: (id: string) => void;
  onProjectDeleted: (id: string) => void;
}) {
  const folders = useWorkspaceFolders(() => props.workspace.id);

  const sortable = useSortable({
    get id() {
      return `ws:${props.workspace.id}`;
    },
    get index() {
      return props.index;
    },
    group: 'workspaces',
    type: DndType.Workspace,
    accept: DndType.Workspace,
    get data() {
      return { workspaceId: props.workspace.id };
    },
  });

  const folderDrop = useDroppable({
    get id() {
      return folderMoveTargetId(props.workspace.id);
    },
    get accept() {
      return props.workspace.type === 'private' ? [] : DndType.Folder;
    },
    collisionPriority: DROP_ZONE_PRIORITY,
    get data() {
      return { workspaceId: props.workspace.id };
    },
  });

  const query = () => props.search.toLowerCase().trim();
  const searchActive = () => query().length > 0;
  const matchesQuery = (text: string | null | undefined) => (text ?? '').toLowerCase().includes(query());

  const view = createMemo(() => {
    const folderList = folders.data ?? [];
    const folderIds = new Set(folderList.map((f) => f.id));
    const byFolder = new Map<string, Project[]>();
    const loose: Project[] = [];
    for (const p of props.projects) {
      if (p.folderId && folderIds.has(p.folderId)) {
        const arr = byFolder.get(p.folderId) ?? [];
        arr.push(p);
        byFolder.set(p.folderId, arr);
      } else {
        loose.push(p);
      }
    }

    if (!searchActive()) {
      const folderView = folderList.map((folder) => ({
        folder,
        projects: byFolder.get(folder.id) ?? [],
        autoExpanded: false,
      }));
      return { folders: folderView, loose, expanded: !props.folded };
    }

    const folderView = folderList
      .map((folder) => {
        const folderProjects = byFolder.get(folder.id) ?? [];
        const nameMatch = matchesQuery(folder.name);
        const matching = folderProjects.filter((p) => matchesQuery(p.title));
        return {
          folder,
          projects: nameMatch ? folderProjects : matching,
          visible: nameMatch || matching.length > 0,
        };
      })
      .filter((entry) => entry.visible)
      .map(({ folder, projects }) => ({ folder, projects, autoExpanded: true }));

    const visibleLoose = loose.filter((p) => matchesQuery(p.title));
    const hasMatch = folderView.length > 0 || visibleLoose.length > 0;
    return { folders: folderView, loose: visibleLoose, expanded: hasMatch || !props.folded };
  });

  return (
    <div ref={sortable.ref} class="flex flex-col" style={{ opacity: sortable.isDragging() ? 0.5 : 1 }}>
      <div
        ref={folderDrop.ref}
        class="group/wsrow relative flex items-center gap-1.5 pl-4 pr-1 py-1 rounded-md hover:bg-sidebar-accent/50 cursor-pointer"
        classList={{ 'bg-sidebar-accent/60 ring-1 ring-sidebar-accent': folderDrop.isDropTarget() }}
        onClick={props.onToggleFold}
      >
        <button
          ref={sortable.handleRef}
          class="absolute left-0 top-1/2 -translate-y-1/2 opacity-0 group-hover/wsrow:opacity-100 transition-opacity cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground"
          onClick={(e) => e.stopPropagation()}
          title="Drag to reorder"
        >
          <GripVertical class="w-3 h-3" />
        </button>
        <span class="text-muted-foreground shrink-0">
          {view().expanded ? <ChevronDown class="w-3 h-3" /> : <ChevronRight class="w-3 h-3" />}
        </span>
        <Show
          when={props.workspace.type === 'private'}
          fallback={<Boxes class="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
        >
          <Lock class="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        </Show>
        <span class="flex-1 min-w-0 text-sm font-medium truncate text-foreground">{props.workspace.name}</span>
        <Show when={props.onOpenSettings}>
          <button
            class="opacity-0 group-hover/wsrow:opacity-100 transition-opacity text-muted-foreground hover:text-foreground p-1 rounded-sm hover:bg-accent"
            onClick={(e) => {
              e.stopPropagation();
              props.onOpenSettings?.();
            }}
            title="Workspace settings"
          >
            <Settings class="w-3.5 h-3.5" />
          </button>
        </Show>
        <SidebarCreateButton title="New project in this workspace" renderCreate={props.renderCreate} />
      </div>

      <Show when={view().expanded}>
        <For each={view().folders}>
          {(entry) => (
            <SidebarFolderGroup
              folder={entry.folder}
              expanded={entry.autoExpanded || props.isFolderExpanded(entry.folder.id)}
              projects={entry.projects}
              activeProjectId={props.activeProjectId}
              onToggleExpanded={() => props.onToggleFolder(entry.folder.id)}
              renderCreate={props.renderFolderCreate(entry.folder)}
              onSelectProject={props.onSelectProject}
              onRenameProject={props.onRenameProject}
              onProjectSettings={props.onProjectSettings}
              onProjectDeleted={props.onProjectDeleted}
            />
          )}
        </For>
        <SidebarDropZone workspaceId={props.workspace.id}>
          <Show
            when={view().loose.length > 0}
            fallback={
              <Show when={view().folders.length === 0}>
                <p class="text-xs text-muted-foreground/50 py-1 px-2 italic">No projects yet.</p>
              </Show>
            }
          >
            <For each={view().loose}>
              {(project) => (
                <SidebarDraggableProjectRow
                  project={project}
                  isActive={project.id === props.activeProjectId}
                  onSelect={() => props.onSelectProject(project.id)}
                  onRename={(id, title) => props.onRenameProject(id, title)}
                  onSettings={() => props.onProjectSettings(project.id)}
                  onDeleted={() => props.onProjectDeleted(project.id)}
                />
              )}
            </For>
          </Show>
        </SidebarDropZone>
      </Show>
    </div>
  );
}
