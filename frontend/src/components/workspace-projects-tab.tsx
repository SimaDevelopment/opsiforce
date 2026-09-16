import { For, Show, createMemo, createSignal } from 'solid-js';
import { type Project } from '~/api/client';
import { useProjects } from '~/api/projects';
import { PUBLIC_LABEL, useMoveProject } from '~/api/workspaces';
import { projectDisplayTitle } from '~/lib/project-display';
import { Button } from '~/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu';
import { Spinner } from '~/components/ui/spinner';
import { ChevronDown, Plus, AppWindow, Trash2 } from '~/components/icons';

export function WorkspaceProjectsTab(props: {
  workspaceId: string;
  workspaceName: string;
  projects: Project[];
}) {
  const [pickerOpen, setPickerOpen] = createSignal(false);
  const allProjects = useProjects({ enabled: () => pickerOpen() });
  const move = useMoveProject();

  const assignable = createMemo(() => (allProjects.data ?? []).filter((p) => p.workspaceId === null));

  const assign = (projectId: string) => {
    move.mutate(
      {
        projectId,
        fromWorkspaceId: null,
        toWorkspaceId: props.workspaceId,
        fromName: PUBLIC_LABEL,
        toName: props.workspaceName,
      },
      { onSuccess: () => setPickerOpen(false) }
    );
  };

  const unassign = (projectId: string) => {
    move.mutate({
      projectId,
      fromWorkspaceId: props.workspaceId,
      toWorkspaceId: null,
      fromName: props.workspaceName,
      toName: PUBLIC_LABEL,
    });
  };

  return (
    <div class="space-y-3">
      <Show
        when={props.projects.length > 0}
        fallback={<p class="text-xs text-muted-foreground text-center py-6">No projects in this workspace yet.</p>}
      >
        <div class="flex flex-col gap-1">
          <For each={props.projects}>
            {(p) => (
              <div class="flex items-center gap-2 p-2 rounded-md border border-border">
                <AppWindow class="w-4 h-4 text-muted-foreground shrink-0" />
                <div class="flex-1 min-w-0">
                  <div class="text-sm truncate">{projectDisplayTitle(p)}</div>
                </div>
                <button
                  class="text-muted-foreground hover:text-destructive p-1.5 rounded-md hover:bg-accent"
                  onClick={() => unassign(p.id)}
                  disabled={move.isPending}
                  title="Remove from workspace"
                >
                  <Trash2 class="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </For>
        </div>
      </Show>

      <DropdownMenu open={pickerOpen()} onOpenChange={setPickerOpen}>
        <DropdownMenuTrigger
          as={(triggerProps: Record<string, unknown>) => (
            <Button {...triggerProps} size="sm" variant="outline" class="w-full">
              <Plus class="w-3.5 h-3.5 mr-1.5" />
              Add existing project
              <ChevronDown class="w-3.5 h-3.5 ml-auto" />
            </Button>
          )}
        />
        <DropdownMenuContent class="min-w-64 max-h-72 overflow-y-auto">
          <Show
            when={assignable().length > 0}
            fallback={
              <Show
                when={allProjects.isLoading}
                fallback={
                  <div class="px-2 py-6 text-xs text-center text-muted-foreground">No public projects available.</div>
                }
              >
                <div class="px-2 py-3">
                  <Spinner size="sm" />
                </div>
              </Show>
            }
          >
            <For each={assignable()}>
              {(p) => (
                <DropdownMenuItem onSelect={() => assign(p.id)}>
                  <span class="text-sm truncate">{projectDisplayTitle(p)}</span>
                </DropdownMenuItem>
              )}
            </For>
          </Show>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
