import { createSignal } from 'solid-js';
import { toast } from 'solid-sonner';
import { useCreateWorkspace } from '~/api/workspaces';
import { Button } from '~/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '~/components/ui/dialog';

export function CreateWorkspaceDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (workspaceId: string) => void;
}) {
  const createWorkspace = useCreateWorkspace();
  const [name, setName] = createSignal('');
  const [description, setDescription] = createSignal('');

  const reset = () => {
    setName('');
    setDescription('');
  };

  const close = () => {
    reset();
    props.onOpenChange(false);
  };

  const handleCreate = async () => {
    const trimmed = name().trim();
    if (!trimmed) return;
    try {
      const ws = await createWorkspace.mutateAsync({
        name: trimmed,
        description: description().trim() || null,
      });
      toast.success('Workspace created');
      close();
      props.onCreated?.(ws.id);
    } catch {
      toast.error('Failed to create workspace');
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
        <DialogTitle>Create new workspace</DialogTitle>
        <DialogDescription>
          A container for grouping projects and controlling which users can see them.
        </DialogDescription>

        <div class="mt-4 space-y-3">
          <div>
            <label class="text-xs text-muted-foreground mb-1 block">Name</label>
            <input
              type="text"
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && name().trim()) handleCreate();
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
              value={description()}
              onInput={(e) => setDescription(e.currentTarget.value)}
              class="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>
        </div>

        <div class="mt-4 flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleCreate} disabled={!name().trim() || createWorkspace.isPending}>
            Create
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
