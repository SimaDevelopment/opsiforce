import { For, Show, createSignal } from 'solid-js';
import { toast } from 'solid-sonner';
import { useCreateWorkspace, useWorkspaces } from '~/api/workspaces';
import { useTenantConfig, useUpdateTenantConfig } from '~/api/tenant-config';
import { Button } from '~/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '~/components/ui/dialog';
import { Spinner } from '~/components/ui/spinner';
import { Switch, SwitchControl, SwitchThumb } from '~/components/ui/switch';
import { SettingsSection } from '~/components/settings/settings-section';
import { WorkspaceSettings } from '~/components/workspace-settings';
import { FolderKanban, Lock, Plus, Settings, AppWindow, Users } from '~/components/icons';

export function WorkspacesPage() {
  const workspaces = useWorkspaces('all');
  const createWorkspace = useCreateWorkspace();
  const tenantConfig = useTenantConfig();
  const updateTenantConfig = useUpdateTenantConfig();

  const handleTogglePrivateWorkspaces = (enabled: boolean) => {
    updateTenantConfig.mutate(
      { privateWorkspaceEnabled: enabled },
      {
        onSuccess: () => toast.success(enabled ? 'Personal workspaces enabled' : 'Personal workspaces disabled'),
        onError: () => toast.error('Failed to update setting'),
      }
    );
  };

  const [openSettingsId, setOpenSettingsId] = createSignal<string | null>(null);
  const [createDialogOpen, setCreateDialogOpen] = createSignal(false);
  const [newName, setNewName] = createSignal('');
  const [newDescription, setNewDescription] = createSignal('');

  const closeCreateDialog = () => {
    setCreateDialogOpen(false);
    setNewName('');
    setNewDescription('');
  };

  const handleCreate = async () => {
    const name = newName().trim();
    if (!name) return;
    try {
      const ws = await createWorkspace.mutateAsync({
        name,
        description: newDescription().trim() || null,
      });
      closeCreateDialog();
      toast.success('Workspace created');
      setOpenSettingsId(ws.id);
    } catch {
      toast.error('Failed to create workspace');
    }
  };

  return (
    <>
      <SettingsSection
        icon={FolderKanban}
        title="Workspaces"
        description="Group and share projects."
        action={
          <Button size="sm" onClick={() => setCreateDialogOpen(true)}>
            <Plus class="w-4 h-4 mr-1.5" />
            New workspace
          </Button>
        }
      >
        <div class="rounded-xl border border-border bg-card p-4 mb-4 flex items-center gap-3">
          <Lock class="w-4 h-4 text-muted-foreground shrink-0" />
          <div class="flex-1 min-w-0">
            <div class="text-sm font-medium">Personal workspaces</div>
            <div class="text-xs text-muted-foreground">
              Give every member a private Personal workspace of their own. When off, existing personal workspaces and
              their projects are hidden, and anyone can create new projects in Public — where the whole organization
              sees them.
            </div>
          </div>
          <Show when={tenantConfig.data} fallback={<Spinner size="sm" />}>
            {(config) => (
              <Switch
                checked={config().privateWorkspaceEnabled}
                onChange={handleTogglePrivateWorkspaces}
                disabled={updateTenantConfig.isPending}
              >
                <SwitchControl>
                  <SwitchThumb />
                </SwitchControl>
              </Switch>
            )}
          </Show>
        </div>

        <Show
          when={workspaces.data}
          fallback={
            <div class="py-20">
              <Spinner />
            </div>
          }
        >
          {(data) => (
            <Show
              when={data().length > 0}
              fallback={
                <div class="rounded-xl border border-border bg-card p-10 text-center">
                  <FolderKanban class="w-10 h-10 text-muted-foreground/30 mx-auto mb-3" stroke-width="1" />
                  <p class="text-sm text-muted-foreground">No workspaces yet.</p>
                  <p class="text-xs text-muted-foreground/60 mt-1">Create one to start grouping projects.</p>
                </div>
              }
            >
              <div class="rounded-xl border border-border bg-card divide-y divide-border">
                <For each={data().filter((w) => w.type !== 'private')}>
                  {(ws) => (
                    <div class="flex items-center gap-3 p-4">
                      <FolderKanban class="w-4 h-4 text-muted-foreground shrink-0" />
                      <div class="flex-1 min-w-0">
                        <div class="text-sm font-medium truncate">{ws.name}</div>
                        <Show when={ws.description}>
                          <div class="text-xs text-muted-foreground truncate">{ws.description}</div>
                        </Show>
                      </div>
                      <div class="flex items-center gap-4 text-xs text-muted-foreground">
                        <span class="flex items-center gap-1">
                          <Users class="w-3 h-3" />
                          <span class="tabular-nums">{ws.memberCount}</span>
                        </span>
                        <span class="flex items-center gap-1">
                          <AppWindow class="w-3 h-3" />
                          <span class="tabular-nums">{ws.projectCount}</span>
                        </span>
                      </div>
                      <Button size="sm" variant="outline" onClick={() => setOpenSettingsId(ws.id)}>
                        <Settings class="w-3.5 h-3.5 mr-1.5" />
                        Configure
                      </Button>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          )}
        </Show>
      </SettingsSection>

      <Dialog
        open={createDialogOpen()}
        onOpenChange={(open) => {
          if (!open) closeCreateDialog();
        }}
      >
        <DialogContent>
          <DialogTitle>Create new workspace</DialogTitle>
          <DialogDescription>
            A container for grouping projects and controlling which users can see them.
          </DialogDescription>

          <div class="mt-4 space-y-3">
            <div>
              <label class="text-xs text-muted-foreground mb-1 block">Name</label>
              <input
                type="text"
                value={newName()}
                onInput={(e) => setNewName(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newName().trim()) handleCreate();
                }}
                class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                placeholder="e.g. Internal tools"
                autofocus
              />
            </div>
            <div>
              <label class="text-xs text-muted-foreground mb-1 block">Description (optional)</label>
              <textarea
                rows={2}
                value={newDescription()}
                onInput={(e) => setNewDescription(e.currentTarget.value)}
                class="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>
          </div>

          <div class="mt-4 flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={closeCreateDialog}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleCreate} disabled={!newName().trim()} loading={createWorkspace.isPending}>
              Create
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Show when={openSettingsId()}>
        {(id) => (
          <WorkspaceSettings
            workspaceId={id()}
            open={true}
            onOpenChange={(open) => {
              if (!open) setOpenSettingsId(null);
            }}
          />
        )}
      </Show>
    </>
  );
}
