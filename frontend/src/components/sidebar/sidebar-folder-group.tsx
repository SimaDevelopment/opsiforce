import { For, Show, createSignal, type JSX } from 'solid-js';
import { useDraggable, useDroppable } from '@dnd-kit/solid';
import { toast } from 'solid-sonner';
import { type Folder, type Project } from '~/api/client';
import { useDeleteFolder } from '~/api/workspaces';
import {
  DndType,
  FOLDER_DROP_ZONE_PRIORITY,
  type FolderDragData,
  folderDragId,
  folderGroupId,
} from '~/lib/sidebar-dnd';
import {
  ChevronDown,
  ChevronRight,
  EllipsisVertical,
  Folder as FolderIcon,
  FolderOpen,
  GripVertical,
  Pencil,
  Trash2,
} from '~/components/icons';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu';
import { ConfirmDialog } from '~/components/ui/confirm-dialog';
import { FolderDialog } from '~/components/folder-dialog';
import { SidebarCreateButton } from './sidebar-create-button';
import { SidebarDraggableProjectRow } from './sidebar-draggable-project-row';

function deleteFolderDescription(folder: Folder): string {
  if (folder.projectCount === 0) return `"${folder.name}" is empty and will be deleted.`;
  const projectsLabel = folder.projectCount === 1 ? '1 project' : `${folder.projectCount} projects`;
  return `${projectsLabel} will move back to the workspace root. No projects will be deleted.`;
}

export function SidebarFolderGroup(props: {
  folder: Folder;
  expanded: boolean;
  projects: Project[];
  activeProjectId: string | undefined;
  onToggleExpanded: () => void;
  renderCreate: (renderTrigger: (triggerProps: Record<string, unknown>) => JSX.Element) => JSX.Element;
  onSelectProject: (id: string) => void;
  onRenameProject: (id: string, title: string) => void;
  onProjectSettings: (id: string) => void;
  onProjectDeleted: (id: string) => void;
}) {
  const deleteFolder = useDeleteFolder();
  const [renameOpen, setRenameOpen] = createSignal(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = createSignal(false);

  const groupId = () => folderGroupId(props.folder.workspaceId, props.folder.id);

  const droppable = useDroppable({
    get id() {
      return groupId();
    },
    accept: DndType.Project,
    collisionPriority: FOLDER_DROP_ZONE_PRIORITY,
    get data() {
      return { workspaceId: props.folder.workspaceId, folderId: props.folder.id };
    },
  });

  const draggable = useDraggable({
    get id() {
      return folderDragId(props.folder.id);
    },
    type: DndType.Folder,
    get data(): FolderDragData {
      return { folderId: props.folder.id, workspaceId: props.folder.workspaceId, folderName: props.folder.name };
    },
  });

  const handleDelete = () =>
    deleteFolder.mutate(
      { workspaceId: props.folder.workspaceId, folderId: props.folder.id },
      {
        onSuccess: () => toast.success('Folder deleted'),
        onError: () => toast.error('Failed to delete folder'),
      }
    );

  return (
    <div
      ref={droppable.ref}
      class="flex flex-col ml-2 rounded-md transition-colors"
      classList={{ 'bg-sidebar-accent/40': droppable.isDropTarget() }}
      style={{ opacity: draggable.isDragging() ? 0.5 : 1 }}
    >
      <div
        ref={draggable.ref}
        class="group/folderrow relative flex items-center gap-1.5 pl-4 pr-1 py-1 rounded-md hover:bg-sidebar-accent/50 cursor-pointer"
        onClick={props.onToggleExpanded}
      >
        <button
          ref={draggable.handleRef}
          class="absolute left-0 top-1/2 -translate-y-1/2 opacity-0 group-hover/folderrow:opacity-100 transition-opacity cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground"
          onClick={(e) => e.stopPropagation()}
          title="Drag to move folder"
        >
          <GripVertical class="w-3 h-3" />
        </button>
        <span class="text-muted-foreground shrink-0">
          {props.expanded ? <ChevronDown class="w-3 h-3" /> : <ChevronRight class="w-3 h-3" />}
        </span>
        <Show when={props.expanded} fallback={<FolderIcon class="w-3.5 h-3.5 text-muted-foreground shrink-0" />}>
          <FolderOpen class="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        </Show>
        <span class="flex-1 min-w-0 text-sm truncate text-foreground">{props.folder.name}</span>
        <DropdownMenu>
          <DropdownMenuTrigger
            class="opacity-0 group-hover/folderrow:opacity-100 data-[expanded]:opacity-100 transition-opacity text-muted-foreground hover:text-foreground p-1 rounded-sm hover:bg-accent"
            onClick={(e: MouseEvent) => e.stopPropagation()}
            aria-label="Folder actions"
          >
            <EllipsisVertical class="w-3.5 h-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent onClick={(e: MouseEvent) => e.stopPropagation()}>
            <DropdownMenuItem onSelect={() => setRenameOpen(true)}>
              <Pencil class="w-3.5 h-3.5 text-muted-foreground" />
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem
              class="text-destructive data-[highlighted]:text-destructive"
              onSelect={() => setConfirmDeleteOpen(true)}
            >
              <Trash2 class="w-3.5 h-3.5" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <SidebarCreateButton title="New project in this folder" variant="folder" renderCreate={props.renderCreate} />
      </div>

      <Show when={props.expanded}>
        <div class="flex flex-col gap-0.5 pl-4">
          <Show
            when={props.projects.length > 0}
            fallback={<p class="text-xs text-muted-foreground/50 py-1 px-2 italic">No projects yet.</p>}
          >
            <For each={props.projects}>
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
        </div>
      </Show>

      <Show when={renameOpen()}>
        <FolderDialog
          workspaceId={props.folder.workspaceId}
          folder={props.folder}
          open={true}
          onOpenChange={setRenameOpen}
        />
      </Show>

      <ConfirmDialog
        open={confirmDeleteOpen()}
        onOpenChange={setConfirmDeleteOpen}
        title={`Delete folder "${props.folder.name}"?`}
        description={deleteFolderDescription(props.folder)}
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={handleDelete}
      />
    </div>
  );
}
