import { Show, createEffect, createSignal } from 'solid-js';
import { toast } from 'solid-sonner';
import { usePermissions } from '~/api/permissions';
import {
  useDeleteWorkspace,
  useUpdateWorkspace,
  useWorkspace,
  useWorkspaceMembers,
  useWorkspaceProjects,
} from '~/api/workspaces';
import { Permission } from '~/constants/permissions';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '~/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '~/components/ui/tabs';
import { Button } from '~/components/ui/button';
import { ConfirmDialog } from '~/components/ui/confirm-dialog';
import { Skeleton } from '~/components/ui/skeleton';
import { Settings, AppWindow, Trash2, Users } from '~/components/icons';
import { WorkspaceMembersTab } from './workspace-members-tab';
import { WorkspaceProjectsTab } from './workspace-projects-tab';

export function WorkspaceSettings(props: {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted?: () => void;
}) {
  const { hasPermission } = usePermissions();
  const canManage = () => hasPermission(Permission.manageWorkspaces);

  const workspaceId = () => props.workspaceId;
  const workspace = useWorkspace(workspaceId);
  const members = useWorkspaceMembers(() => (props.open ? props.workspaceId : null));
  const projectsInWorkspace = useWorkspaceProjects(() => (props.open ? props.workspaceId : null));

  const update = useUpdateWorkspace();
  const remove = useDeleteWorkspace();

  const [name, setName] = createSignal('');
  const [description, setDescription] = createSignal('');
  const [dirty, setDirty] = createSignal(false);
  const [activeTab, setActiveTab] = createSignal('general');
  const [confirmDeleteOpen, setConfirmDeleteOpen] = createSignal(false);

  createEffect(() => {
    const w = workspace.data;
    if (w) {
      if (w.type === 'private') {
        props.onOpenChange(false);
        return;
      }
      setName(w.name);
      setDescription(w.description ?? '');
      setDirty(false);
    }
  });

  const handleSave = async () => {
    if (!dirty()) return;
    try {
      await update.mutateAsync({
        id: props.workspaceId,
        dto: { name: name().trim(), description: description().trim() || null },
      });
      setDirty(false);
      toast.success('Workspace updated');
    } catch {
      toast.error('Failed to save');
    }
  };

  const handleDelete = async () => {
    try {
      await remove.mutateAsync(props.workspaceId);
      toast.success('Workspace deleted');
      props.onOpenChange(false);
      props.onDeleted?.();
    } catch {
      toast.error('Failed to delete');
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogTitle>Workspace Settings</DialogTitle>
        <DialogDescription>
          <Show when={workspace.data?.name} fallback={<Skeleton class="h-4 w-32 inline-block" />}>
            {workspace.data?.name}
          </Show>
        </DialogDescription>

        <Show
          when={canManage()}
          fallback={
            <div class="mt-4 p-4 rounded-lg border border-border bg-muted/30 text-center">
              <p class="text-sm text-muted-foreground">You do not have permission to manage workspaces.</p>
            </div>
          }
        >
          <Tabs defaultValue="general" class="mt-4" onChange={setActiveTab}>
            <TabsList>
              <TabsTrigger value="general">
                <Settings class="w-3.5 h-3.5 mr-1.5" />
                General
              </TabsTrigger>
              <TabsTrigger value="members">
                <Users class="w-3.5 h-3.5 mr-1.5" />
                Members
                <span class="ml-1.5 text-xs text-muted-foreground">{members.data?.length ?? 0}</span>
              </TabsTrigger>
              <TabsTrigger value="projects">
                <AppWindow class="w-3.5 h-3.5 mr-1.5" />
                Projects
                <span class="ml-1.5 text-xs text-muted-foreground">{projectsInWorkspace.data?.length ?? 0}</span>
              </TabsTrigger>
            </TabsList>

            <TabsContent value="general">
              <div class="space-y-3">
                <div>
                  <label class="text-xs text-muted-foreground mb-1 block">Name</label>
                  <input
                    type="text"
                    value={name()}
                    onInput={(e) => {
                      setName(e.currentTarget.value);
                      setDirty(true);
                    }}
                    class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    placeholder="Workspace name"
                  />
                </div>
                <div>
                  <label class="text-xs text-muted-foreground mb-1 block">Description</label>
                  <textarea
                    rows={3}
                    value={description()}
                    onInput={(e) => {
                      setDescription(e.currentTarget.value);
                      setDirty(true);
                    }}
                    class="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    placeholder="What's this workspace for?"
                  />
                </div>

                <div class="pt-2 border-t border-border">
                  <Button
                    size="sm"
                    variant="outline"
                    class="text-destructive hover:text-destructive"
                    onClick={() => setConfirmDeleteOpen(true)}
                    loading={remove.isPending}
                  >
                    <Trash2 class="w-3.5 h-3.5 mr-1.5" />
                    Delete workspace
                  </Button>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="members">
              <WorkspaceMembersTab workspaceId={props.workspaceId} members={members.data ?? []} />
            </TabsContent>

            <TabsContent value="projects">
              <WorkspaceProjectsTab
                workspaceId={props.workspaceId}
                workspaceName={workspace.data?.name ?? ''}
                projects={projectsInWorkspace.data ?? []}
              />
            </TabsContent>
          </Tabs>

          <div class="mt-4 flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => props.onOpenChange(false)}>
              Cancel
            </Button>
            <Show when={activeTab() === 'general'}>
              <Button size="sm" disabled={!dirty() || !name().trim()} loading={update.isPending} onClick={handleSave}>
                Save
              </Button>
            </Show>
          </div>
        </Show>
      </DialogContent>

      <ConfirmDialog
        open={confirmDeleteOpen()}
        onOpenChange={setConfirmDeleteOpen}
        title={`Delete "${workspace.data?.name ?? 'workspace'}"?`}
        description="Projects move to the Public bucket — visible to everyone in the organization."
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={handleDelete}
      />
    </Dialog>
  );
}
