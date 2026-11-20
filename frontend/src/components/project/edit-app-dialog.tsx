import { Show, createEffect, createMemo, createSignal } from 'solid-js';
import { toast } from '~/lib/toast';
import { useUpdateApp } from '~/api/projects';
import { Button } from '~/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '~/components/ui/dialog';

// TODO: replace these hand-rolled validators with zod schemas once zod is introduced.
const APP_NAME_MIN_LENGTH = 1;
const APP_NAME_MAX_LENGTH = 80;
const APP_DESCRIPTION_MAX_LENGTH = 500;

function validateAppName(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length < APP_NAME_MIN_LENGTH) return 'Name is required';
  if (trimmed.length > APP_NAME_MAX_LENGTH) {
    return `Name must be at most ${APP_NAME_MAX_LENGTH} characters`;
  }
  return null;
}

function validateAppDescription(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length > APP_DESCRIPTION_MAX_LENGTH) {
    return `Description must be at most ${APP_DESCRIPTION_MAX_LENGTH} characters`;
  }
  return null;
}

export interface EditAppDialogProps {
  projectId: string;
  environmentId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialName: string | null;
  initialDescription: string | null;
}

export function EditAppDialog(props: EditAppDialogProps) {
  const updateApp = useUpdateApp();
  const [name, setName] = createSignal('');
  const [description, setDescription] = createSignal('');

  createEffect(() => {
    if (props.open) {
      setName(props.initialName ?? '');
      setDescription(props.initialDescription ?? '');
    }
  });

  const nameError = createMemo(() => validateAppName(name()));
  const descriptionError = createMemo(() => validateAppDescription(description()));

  const isDirty = createMemo(() => {
    const initialName = (props.initialName ?? '').trim();
    const initialDesc = (props.initialDescription ?? '').trim();
    return name().trim() !== initialName || description().trim() !== initialDesc;
  });

  const canSave = () => !nameError() && !descriptionError() && isDirty() && !updateApp.isPending;

  const close = () => props.onOpenChange(false);

  const handleSave = async () => {
    if (!canSave()) return;
    const trimmedName = name().trim();
    const trimmedDescription = description().trim();
    const initialName = (props.initialName ?? '').trim();
    const initialDesc = (props.initialDescription ?? '').trim();

    const payload: { name?: string; description?: string | null } = {};
    if (trimmedName !== initialName) payload.name = trimmedName;
    if (trimmedDescription !== initialDesc) {
      payload.description = trimmedDescription.length === 0 ? null : trimmedDescription;
    }

    try {
      await updateApp.mutateAsync({ projectId: props.projectId, environmentId: props.environmentId, payload });
      toast.success('App details updated');
      close();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update app details');
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
        <DialogTitle>Edit app details</DialogTitle>
        <div class="mt-4 space-y-3">
          <div>
            <label class="text-xs text-muted-foreground mb-1 block">Name</label>
            <input
              type="text"
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSave()) handleSave();
              }}
              class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              placeholder="My App"
              maxLength={APP_NAME_MAX_LENGTH}
              autofocus
            />
            <Show when={nameError()}>
              <p class="mt-1 text-xs text-destructive">{nameError()}</p>
            </Show>
          </div>
          <div>
            <label class="text-xs text-muted-foreground mb-1 block">Description (optional)</label>
            <textarea
              rows={3}
              value={description()}
              onInput={(e) => setDescription(e.currentTarget.value)}
              maxLength={APP_DESCRIPTION_MAX_LENGTH}
              class="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              placeholder="A short description of what the app does"
            />
            <Show when={descriptionError()}>
              <p class="mt-1 text-xs text-destructive">{descriptionError()}</p>
            </Show>
          </div>
        </div>

        <div class="mt-4 flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} disabled={!canSave()}>
            Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
