import { Index, Show, createEffect, createSignal } from 'solid-js';
import { toast } from 'solid-sonner';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '~/components/ui/dialog';
import { Button } from '~/components/ui/button';
import { Skeleton } from '~/components/ui/skeleton';
import { Switch, SwitchControl, SwitchLabel, SwitchThumb } from '~/components/ui/switch';
import { Plus, SlidersHorizontal, Trash2 } from '~/components/icons';
import { useEnvironmentVariables, useUpdateEnvironmentVariables } from '~/api/environment-variables';
import type { ProjectEnvironment } from '~/api/environments';

interface VariableDraft {
  key: string;
  value: string;
}

export interface EnvironmentVariablesDialogProps {
  projectId: string;
  environment: ProjectEnvironment | null;
  onOpenChange: (open: boolean) => void;
}

export function EnvironmentVariablesDialog(props: EnvironmentVariablesDialogProps) {
  const open = () => props.environment !== null;
  const environmentId = () => props.environment?.id ?? '';
  const environmentName = () => props.environment?.name ?? '';
  const isDevelopment = () => props.environment?.isDefault === true;

  const [drafts, setDrafts] = createSignal<VariableDraft[]>([]);
  const [restartApp, setRestartApp] = createSignal(false);
  const [loadedFor, setLoadedFor] = createSignal<string | null>(null);

  const query = useEnvironmentVariables(() => props.projectId, environmentId, { enabled: open });
  const update = useUpdateEnvironmentVariables();

  createEffect(() => {
    if (!open()) {
      setLoadedFor(null);
      return;
    }
    if (loadedFor() === environmentId()) return;
    const data = query.data;
    if (!data) return;
    setDrafts(data.variables.map((v) => ({ key: v.key, value: v.value })));
    setRestartApp(!isDevelopment());
    setLoadedFor(environmentId());
  });

  const setDraft = (index: number, patch: Partial<VariableDraft>) => {
    setDrafts((prev) => prev.map((d, i) => (i === index ? { ...d, ...patch } : d)));
  };

  const addDraft = () => setDrafts((prev) => [...prev, { key: '', value: '' }]);

  const removeDraft = (index: number) => setDrafts((prev) => prev.filter((_, i) => i !== index));

  const save = () => {
    const environment = props.environment;
    if (!environment) return;
    const variables = Object.fromEntries(
      drafts()
        .map((d) => [d.key.trim(), d.value] as const)
        .filter(([key]) => key.length > 0)
    );
    update.mutate(
      {
        projectId: props.projectId,
        environmentId: environment.id,
        variables,
        restartApp: restartApp(),
      },
      {
        onSuccess: (result) => {
          if (result.restart === 'app') toast.success('Variables saved — restarting the app');
          else if (result.restart === 'pod')
            toast.success('Variables saved — restarting the environment to apply them');
          else toast.success('Variables saved');
          props.onOpenChange(false);
        },
        onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to save variables'),
      }
    );
  };

  return (
    <Dialog
      open={open()}
      onOpenChange={(value) => {
        if (!value) props.onOpenChange(false);
      }}
    >
      <DialogContent class="flex max-h-[85vh] max-w-lg flex-col">
        <DialogTitle class="flex items-center gap-2">
          <SlidersHorizontal class="h-4 w-4 text-primary" />
          Environment variables — {environmentName()}
        </DialogTitle>
        <DialogDescription>
          Configuration values the app reads when it starts. Changes take effect after the app restarts.
        </DialogDescription>

        <Show when={!query.isPending} fallback={<Skeleton class="mt-4 h-24 w-full" />}>
          <div class="-ml-1 -mr-2 mt-3 min-h-0 flex-1 space-y-2 overflow-y-auto overflow-x-hidden py-1 pl-1 pr-2">
            <Show
              when={drafts().length > 0}
              fallback={
                <p class="rounded-md border border-border bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground">
                  No variables yet. Add one below.
                </p>
              }
            >
              <Index each={drafts()}>
                {(draft, index) => (
                  <div class="flex items-center gap-2">
                    <input
                      type="text"
                      value={draft().key}
                      onInput={(e) => setDraft(index, { key: e.currentTarget.value })}
                      class="h-8 w-2/5 shrink-0 rounded-md border border-input bg-background px-3 py-1.5 font-mono text-xs shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                      placeholder="KEY"
                      aria-label={`Variable ${index + 1} name`}
                    />
                    <input
                      type="text"
                      value={draft().value}
                      onInput={(e) => setDraft(index, { value: e.currentTarget.value })}
                      class="h-8 flex-1 rounded-md border border-input bg-background px-3 py-1.5 text-xs shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                      placeholder="value"
                      aria-label={draft().key ? `${draft().key} value` : `Variable ${index + 1} value`}
                    />
                    <button
                      class="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-destructive focus-visible:bg-accent focus-visible:text-destructive"
                      aria-label="Remove variable"
                      onClick={() => removeDraft(index)}
                    >
                      <Trash2 class="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
              </Index>
            </Show>
          </div>

          <div class="mt-2 shrink-0">
            <Button size="sm" variant="outline" onClick={addDraft}>
              <Plus class="h-3.5 w-3.5" />
              Add variable
            </Button>
          </div>

          <div class="mt-4 shrink-0 rounded-md border border-border bg-muted/30 px-3 py-2.5">
            <Switch checked={restartApp()} onChange={setRestartApp} class="gap-2.5">
              <SwitchControl>
                <SwitchThumb />
              </SwitchControl>
              <SwitchLabel class="text-xs text-foreground">Restart app to apply now</SwitchLabel>
            </Switch>
            <p class="mt-1.5 text-xs text-muted-foreground">
              {restartApp()
                ? 'The app restarts right after saving and picks up the new values.'
                : 'Values are saved now and apply the next time the app restarts.'}
            </p>
          </div>
        </Show>

        <div class="mt-5 flex shrink-0 justify-end gap-2">
          <Button size="sm" variant="outline" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={save} loading={update.isPending} disabled={query.isPending}>
            Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
