import { Show, createEffect, createSignal, on } from 'solid-js';
import { toast } from 'solid-sonner';
import type { ProjectEnvironment } from '~/api/environments';
import { useUpdateApp } from '~/api/projects';
import { AlertTriangle } from '~/components/icons';
import { Button } from '~/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '~/components/ui/dialog';
import { appHostSuffix, readableAppUrl } from '~/lib/app-url';

export interface EditAppUrlDialogProps {
  projectId: string;
  environment: ProjectEnvironment | null;
  onOpenChange: (open: boolean) => void;
}

export function EditAppUrlDialog(props: EditAppUrlDialogProps) {
  const updateApp = useUpdateApp();
  const [appSlug, setAppSlug] = createSignal('');
  const [refusal, setRefusal] = createSignal<string | null>(null);

  createEffect(
    on(
      () => props.environment?.id,
      () => {
        setAppSlug(props.environment?.appSlug ?? props.environment?.suggestedAppSlug ?? '');
        setRefusal(null);
      }
    )
  );

  const newAddress = () => (props.environment ? readableAppUrl(appSlug(), props.environment) : '');
  const hostSuffix = () => (props.environment ? appHostSuffix(props.environment) : '');
  const newSignInCallback = () => `${newAddress()}oidc/callback`;
  const signsInOutside = () => props.environment?.authMode === 'manual';
  const isDirty = () => appSlug() !== (props.environment?.appSlug ?? '');
  const showsNewAddress = () => isDirty() && appSlug() !== '';
  const canSave = () => isDirty() && !updateApp.isPending;

  const close = () => props.onOpenChange(false);

  const handleSave = async () => {
    const environment = props.environment;
    if (!environment || !canSave()) return;
    try {
      await updateApp.mutateAsync({
        projectId: props.projectId,
        environmentId: environment.id,
        payload: { appSlug: appSlug() },
      });
      toast.success('Public URL updated');
      close();
    } catch (err) {
      setRefusal(err instanceof Error ? err.message : 'Failed to update the Public URL');
    }
  };

  return (
    <Dialog
      open={props.environment !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent>
        <DialogTitle>Edit URL</DialogTitle>
        <DialogDescription>
          Choose the readable start of the {props.environment?.name} address.{' '}
          <Show
            when={props.environment?.appSlug}
            fallback="Links shared before keep working as they are, so nothing breaks. Give people the new address from now on."
          >
            Links shared before keep working: browsers land on the new address, but webhooks and API clients must be
            pointed at it.
          </Show>
        </DialogDescription>
        <div class="mt-4 space-y-3">
          <div>
            <label class="text-xs text-muted-foreground mb-1 block" for="edit-app-url-slug">
              Readable part
            </label>
            <input
              id="edit-app-url-slug"
              type="text"
              value={appSlug()}
              onInput={(e) => {
                setAppSlug(e.currentTarget.value);
                setRefusal(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSave()) handleSave();
              }}
              class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 font-mono text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              placeholder="warehouse"
              spellcheck={false}
              autocomplete="off"
              autofocus
            />
            <Show
              when={refusal()}
              fallback={
                <p class="mt-1.5 break-all text-xs text-muted-foreground">
                  <Show when={showsNewAddress()} fallback={props.environment?.publicUrl}>
                    https://<span class="font-medium text-foreground">{appSlug()}</span>
                    {hostSuffix()}/
                  </Show>
                </p>
              }
            >
              <p class="mt-1.5 text-xs text-destructive">{refusal()}</p>
            </Show>
          </div>
          <Show when={showsNewAddress()}>
            <p class="break-all text-xs text-muted-foreground">Current address: {props.environment?.publicUrl}</p>
          </Show>
          <Show when={signsInOutside() && showsNewAddress()}>
            <div
              class="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs"
              role="alert"
            >
              <AlertTriangle class="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" aria-hidden="true" />
              <div class="min-w-0 flex-1 space-y-1 break-words">
                <p>
                  This App signs visitors in with your identity provider. Register this sign-in callback there before
                  saving, and keep the current one registered so earlier links still sign in:
                </p>
                <p class="break-all font-mono">{newSignInCallback()}</p>
              </div>
            </div>
          </Show>
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
