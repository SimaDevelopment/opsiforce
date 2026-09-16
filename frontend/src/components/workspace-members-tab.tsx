import { For, Show, createMemo, createSignal } from 'solid-js';
import { toast } from 'solid-sonner';
import { type User } from '~/api/client';
import { useUsers } from '~/api/users';
import { useAddWorkspaceMember, useRemoveWorkspaceMember } from '~/api/workspaces';
import { Button } from '~/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu';
import { Spinner } from '~/components/ui/spinner';
import { ChevronDown, Plus, Trash2 } from '~/components/icons';

export function WorkspaceMembersTab(props: { workspaceId: string; members: User[] }) {
  const [pickerOpen, setPickerOpen] = createSignal(false);
  const users = useUsers(() => pickerOpen());
  const addMember = useAddWorkspaceMember();
  const removeMember = useRemoveWorkspaceMember();

  const memberIds = createMemo(() => new Set(props.members.map((m) => m.id)));
  const addable = createMemo(() => (users.data ?? []).filter((u) => !memberIds().has(u.id)));

  return (
    <div class="space-y-3">
      <Show
        when={props.members.length > 0}
        fallback={
          <p class="text-xs text-muted-foreground text-center py-6">
            No members yet. Add users to grant them visibility of this workspace's projects.
          </p>
        }
      >
        <div class="flex flex-col gap-1">
          <For each={props.members}>
            {(m) => (
              <div class="flex items-center gap-2 p-2 rounded-md border border-border">
                <div class="w-7 h-7 rounded-full bg-sidebar-accent flex items-center justify-center text-xs font-semibold text-sidebar-foreground">
                  {(m.displayName ?? m.email ?? '?').charAt(0).toUpperCase()}
                </div>
                <div class="flex-1 min-w-0">
                  <div class="text-sm font-medium truncate">{m.displayName ?? m.email ?? m.id}</div>
                </div>
                <button
                  class="text-muted-foreground hover:text-destructive p-1.5 rounded-md hover:bg-accent"
                  onClick={() =>
                    removeMember.mutate(
                      { workspaceId: props.workspaceId, userId: m.id },
                      {
                        onSuccess: () => toast.success('Member removed'),
                        onError: () => toast.error('Failed to remove member'),
                      }
                    )
                  }
                  title="Remove"
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
              Add member
              <ChevronDown class="w-3.5 h-3.5 ml-auto" />
            </Button>
          )}
        />
        <DropdownMenuContent class="min-w-64 max-h-72 overflow-y-auto">
          <Show
            when={addable().length > 0}
            fallback={
              <Show
                when={users.isLoading}
                fallback={<div class="px-2 py-6 text-xs text-center text-muted-foreground">No users available.</div>}
              >
                <div class="px-2 py-3">
                  <Spinner size="sm" />
                </div>
              </Show>
            }
          >
            <For each={addable()}>
              {(u) => (
                <DropdownMenuItem
                  onSelect={() => {
                    addMember.mutate(
                      { workspaceId: props.workspaceId, userId: u.id },
                      {
                        onSuccess: () => toast.success('Member added'),
                        onError: () => toast.error('Failed to add member'),
                      }
                    );
                    setPickerOpen(false);
                  }}
                >
                  <span class="text-sm truncate">{u.displayName ?? u.email ?? u.id}</span>
                </DropdownMenuItem>
              )}
            </For>
          </Show>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
