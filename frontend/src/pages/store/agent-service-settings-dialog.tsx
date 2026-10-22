import { Match, Show, Switch, untrack } from 'solid-js';
import { toast } from 'solid-sonner';
import { serviceSettingsFormOf, valueFieldsOf, type Field } from '@opsiforce/external-service-sdk/forms';
import {
  useAgentServiceSettings,
  useSetAgentServiceSettings,
  type AgentServiceSettings,
  type AgentServiceSettingsView,
} from '~/api/agents';
import { ApiError } from '~/api/client';
import { usePermissions } from '~/api/permissions';
import { useConfigurationForm } from '~/components/external-service-form/configuration-form';
import type { FormContext } from '~/components/external-service-form/form-context';
import { ServiceFormFields } from '~/components/external-service-form/form-renderer';
import { withDefaults, type FormValues } from '~/components/external-service-form/form-values';
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

export function serviceSettingsSummary(settings: AgentServiceSettings | null): string {
  if (!settings) return 'No service settings: new Projects start unconfigured';
  const set = Object.keys(settings).length;
  return set === 0
    ? "New Projects start from the service's defaults"
    : `New Projects start with ${set} setting${set === 1 ? '' : 's'} set`;
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
          <FieldSettingsEditor
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

function optionalFields(fields: readonly Field[]): Field[] {
  return fields.map((field) => {
    if (field.type === 'section') return { ...field, fields: optionalFields(field.fields) as typeof field.fields };
    return 'required' in field ? { ...field, required: false } : field;
  });
}

function settingsWorthKeeping(
  form: readonly Field[],
  values: FormValues,
  saved: AgentServiceSettings
): AgentServiceSettings {
  const defaults = withDefaults(form, {});
  return Object.fromEntries(
    valueFieldsOf(form)
      .map((field) => field.key)
      .filter((key) => values[key] !== undefined)
      .filter((key) => key in saved || JSON.stringify(values[key]) !== JSON.stringify(defaults[key]))
      .map((key) => [key, values[key]])
  );
}

function FieldSettingsEditor(props: {
  view: AgentServiceSettingsView;
  agentId: string;
  skillId: string;
  onClose: () => void;
}) {
  const { hasPermission } = usePermissions();
  const form = optionalFields(serviceSettingsFormOf(props.view.service.manifest.projectForm ?? []));
  const saved: AgentServiceSettings = props.view.settings ?? {};
  const save = useSetAgentServiceSettings(() => props.agentId);
  const canSet = () => hasPermission(Permission.configureProjectExternalServices);
  const editor = useConfigurationForm({
    form,
    initial: withDefaults(form, saved),
    missing: [],
    save: {
      mutateAsync: (values) =>
        save.mutateAsync({ skillId: props.skillId, settings: { values: settingsWorthKeeping(form, values, saved) } }),
      get isPending() {
        return save.isPending;
      },
    },
    onEdit: () => {},
    onSaved: () => {
      toast.success(`Saved the service settings of ${props.view.service.displayName}`);
      props.onClose();
    },
    saveFailedMessage: 'The service settings could not be saved.',
  });

  const ctx: FormContext = {
    draft: editor.draft,
    readOnly: () => !canSet() || editor.saving(),
    templateValues: () => ({}),
    serviceConfigurationOptions: () => [],
    storedLabel: () => undefined,
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle class="pr-8">Service settings: {props.view.service.displayName}</DialogTitle>
        <DialogDescription>
          Every Project of this agent created from now on starts with these values in its own configuration of the
          service. Repositories, boards and other targets are picked per Project; existing Projects keep their
          configuration.
        </DialogDescription>
      </DialogHeader>
      <form
        class="mt-4 flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void editor.submit();
        }}
      >
        <Show when={!canSet()}>
          <div class="flex items-center gap-2 rounded-md border border-dashed border-border px-2.5 py-2 text-[11px] text-muted-foreground">
            <Lock class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            Setting these needs the "Configure project External Services" permission.
          </div>
        </Show>
        <Show
          when={form.length > 0}
          fallback={
            <p class="text-xs text-muted-foreground">
              This service has no settings an agent can carry: everything in its Project form is picked per Project.
            </p>
          }
        >
          <ServiceFormFields fields={form} ctx={ctx} />
        </Show>
        <Show when={editor.failure()}>
          {(message) => (
            <p class="text-xs text-destructive" role="alert">
              {message()}
            </p>
          )}
        </Show>
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={() => props.onClose()}>
            {canSet() ? 'Cancel' : 'Close'}
          </Button>
          <Show when={canSet() && form.length > 0}>
            <Button type="submit" size="sm" disabled={editor.saving()}>
              Save
            </Button>
          </Show>
        </DialogFooter>
      </form>
    </>
  );
}
