import { Match, Show, Switch, createSignal, untrack } from 'solid-js';
import { createStore } from 'solid-js/store';
import { toast } from 'solid-sonner';
import {
  useAgentServiceSettings,
  useSetAgentServiceSettings,
  type AgentServiceSettings,
  type AgentServiceSettingsView,
} from '~/api/agents';
import { ApiError } from '~/api/client';
import { usePermissions } from '~/api/permissions';
import { OperationSwitches, ReceiveSwitches } from '~/components/external-service-form/generated-switches';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Spinner } from '~/components/ui/spinner';
import { Lock } from '~/components/icons';
import { Permission } from '~/constants/permissions';

type Switches = Record<string, boolean>;

function switchesOf(declared: Record<string, unknown> | undefined, on: readonly string[]): Switches {
  return Object.fromEntries(Object.keys(declared ?? {}).map((name) => [name, on.includes(name)]));
}

function namesOn(switches: Switches): string[] {
  return Object.entries(switches)
    .filter(([, on]) => on)
    .map(([name]) => name);
}

export function serviceSettingsSummary(settings: AgentServiceSettings | null): string {
  if (!settings) return 'No service settings: new Projects start unconfigured';
  const operations = settings.operations.length;
  const events = settings.receive.length;
  return `New Projects start with ${operations} Operation${operations === 1 ? '' : 's'} and ${events} Event${events === 1 ? '' : 's'} on`;
}

export function ServiceSettingsDialog(props: { agentId: string; skillId: string | null; onClose: () => void }) {
  return (
    <Dialog open={props.skillId !== null} onOpenChange={(open) => !open && props.onClose()}>
      <Show when={props.skillId} keyed>
        {(skillId) => (
          <DialogContent class="max-h-[85vh] max-w-xl overflow-y-auto" align="top">
            <ServiceSettingsLoader agentId={props.agentId} skillId={skillId} onClose={props.onClose} />
          </DialogContent>
        )}
      </Show>
    </Dialog>
  );
}

function ServiceSettingsLoader(props: { agentId: string; skillId: string; onClose: () => void }) {
  const view = useAgentServiceSettings(
    () => props.agentId,
    () => props.skillId
  );
  return (
    <Switch fallback={<Spinner label="Loading…" />}>
      <Match when={view.error}>
        <p class="text-xs text-destructive" role="alert">
          {view.error instanceof ApiError ? view.error.message : 'The service settings could not be loaded.'}
        </p>
      </Match>
      <Match when={view.data}>
        {(loaded) => (
          <ServiceSettingsEditor
            view={untrack(loaded)}
            agentId={props.agentId}
            skillId={props.skillId}
            onClose={props.onClose}
          />
        )}
      </Match>
    </Switch>
  );
}

function ServiceSettingsEditor(props: {
  view: AgentServiceSettingsView;
  agentId: string;
  skillId: string;
  onClose: () => void;
}) {
  const { hasPermission } = usePermissions();
  const manifest = props.view.service.manifest;
  const saved = props.view.settings ?? { operations: [], receive: [] };
  const [operations, setOperations] = createStore<Switches>(switchesOf(manifest.operations, saved.operations));
  const [receive, setReceive] = createStore<Switches>(switchesOf(manifest.events, saved.receive));
  const [error, setError] = createSignal<string | null>(null);
  const save = useSetAgentServiceSettings(() => props.agentId);

  const canGrantWrites = () => hasPermission(Permission.configureProjectExternalServices);
  const grantsWrite = (name: string) =>
    manifest.operations?.[name]?.kind !== 'read' && !saved.operations.includes(name);

  const submit = async () => {
    setError(null);
    try {
      await save.mutateAsync({
        skillId: props.skillId,
        settings: { operations: namesOn(operations), receive: namesOn(receive) },
      });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The service settings could not be saved.');
      return;
    }
    toast.success(`Saved the service settings of ${props.view.service.displayName}`);
    props.onClose();
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle class="pr-8">Service settings: {props.view.service.displayName}</DialogTitle>
        <DialogDescription>
          Every Project of this agent created from now on starts with these switches in its own configuration of the
          service. Targets are picked per Project; existing Projects keep their configuration.
        </DialogDescription>
      </DialogHeader>
      <form
        class="mt-4 flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Show when={!canGrantWrites()}>
          <div class="flex items-center gap-2 rounded-md border border-dashed border-border px-2.5 py-2 text-[11px] text-muted-foreground">
            <Lock class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            Turning a write or destructive Operation on needs the "Configure project External Services" permission.
          </div>
        </Show>
        <OperationSwitches
          manifest={manifest}
          switches={operations}
          newNames={[]}
          readOnly={save.isPending}
          onChange={(name, on) => {
            if (on && grantsWrite(name) && !canGrantWrites()) return;
            setOperations(name, on);
          }}
        />
        <ReceiveSwitches
          manifest={manifest}
          switches={receive}
          newNames={[]}
          readOnly={save.isPending}
          onChange={(type, on) => setReceive(type, on)}
        />
        <Show when={error()}>
          <p class="text-xs text-destructive" role="alert">
            {error()}
          </p>
        </Show>
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={() => props.onClose()}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={save.isPending}>
            Save
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}
