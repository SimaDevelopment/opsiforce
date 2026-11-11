import { Show, createSignal } from 'solid-js';
import { toast } from '~/lib/toast';
import { ApiError, type Folder } from '~/api/client';
import { useCreateFolder, useRenameFolder } from '~/api/workspaces';
import { Button } from '~/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '~/components/ui/dialog';

export const FOLDER_DESCRIPTION = 'A named collection of projects within this workspace.';

export function FolderDialog(props: {
  workspaceId: string;
  folder?: Folder;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: (folder: Folder) => void;
}) {
  const createFolder = useCreateFolder();
  const renameFolder = useRenameFolder();
  const [name, setName] = createSignal(props.folder?.name ?? '');
  const [conflictError, setConflictError] = createSignal<string | null>(null);

  const isRename = () => !!props.folder;
  const isPending = () => createFolder.isPending || renameFolder.isPending;

  const close = () => {
    setName(props.folder?.name ?? '');
    setConflictError(null);
    props.onOpenChange(false);
  };

  const handleSave = async () => {
    const trimmed = name().trim();
    if (!trimmed) return;
    setConflictError(null);
    try {
      const existing = props.folder;
      const folder = existing
        ? await renameFolder.mutateAsync({ workspaceId: props.workspaceId, folderId: existing.id, name: trimmed })
        : await createFolder.mutateAsync({ workspaceId: props.workspaceId, name: trimmed });
      toast.success(existing ? 'Folder renamed' : 'Folder created');
      close();
      props.onSaved?.(folder);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setConflictError(err.message);
        return;
      }
      toast.error(isRename() ? 'Failed to rename folder' : 'Failed to create folder');
    }
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent>
        <DialogTitle>{isRename() ? 'Rename folder' : 'Create new folder'}</DialogTitle>
        <DialogDescription>{FOLDER_DESCRIPTION}</DialogDescription>

        <div class="mt-4">
          <label class="text-xs text-muted-foreground mb-1 block">Name</label>
          <input
            type="text"
            value={name()}
            onInput={(e) => {
              setName(e.currentTarget.value);
              setConflictError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name().trim()) handleSave();
            }}
            class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            placeholder="e.g. Prototypes"
            autofocus
          />
          <Show when={conflictError()}>
            <p class="text-xs text-destructive mt-1">{conflictError()}</p>
          </Show>
        </div>

        <div class="mt-4 flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} disabled={!name().trim() || isPending()}>
            {isRename() ? 'Rename' : 'Create'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
