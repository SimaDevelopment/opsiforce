import { Match, Show, Switch, untrack } from 'solid-js';
import { toast } from 'solid-sonner';
import { labelsKey, serviceSettingsFormOf, valueFieldsOf, type Field } from '@opsiforce/external-service-sdk/forms';
import {
  callAgentServiceSettingsOptions,
  useAgentServiceSettings,
  useSetAgentServiceSettings,
  type AgentProfileSkill,
  type AgentServiceSettings,
  type AgentServiceSettingsView,
} from '~/api/agents';
import { ApiError } from '~/api/client';
import { usePermissions } from '~/api/permissions';
import { useConfigurationForm } from '~/components/external-service-form/configuration-form';
import {
  serviceConfigurationOptionsIn,
  type FormContext,
  type ServiceCaller,
} from '~/components/external-service-form/form-context';
import type { ValueLabels } from '~/components/external-service-form/form-labels';
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

function savedValuesOf(settings: AgentServiceSettings | null): { values: AgentServiceSettings; labels: ValueLabels } {
  const { [labelsKey]: labels, ...values } = settings ?? {};
  return { values, labels: (labels ?? {}) as ValueLabels };
}

export function serviceSettingsSummary(
  skill: Pick<AgentProfileSkill, 'serviceSettings' | 'serviceConnectedByDefault'>
): string {
  if (!skill.serviceSettings && !skill.serviceConnectedByDefault) {
    return 'No service settings: new Projects start unconfigured';
  }
  const set = Object.keys(savedValuesOf(skill.serviceSettings).values).length;
  return set === 0
    ? "New Projects start from the service's defaults"
    : `New Projects start with ${set} setting${set === 1 ? '' : 's'} set`;
}

interface OpenedServiceSettings {
  agentId: string;
  skillId: string;
  newProjectsEnvironment?: string;
  onClose: () => void;
}

export function ServiceSettingsDialog(props: {
  agentId: string;
  skillId: string | null;
  newProjectsEnvironment?: string;
  onClose: () => void;
}) {
  return (
    <Dialog open={props.skillId !== null} onOpenChange={(open) => !open && props.onClose()}>
      <Show when={props.skillId} keyed>
        {(skillId) => (
          <DialogContent class="max-h-[85vh] max-w-xl overflow-y-auto">
            <ServiceSettingsLoader
              agentId={props.agentId}
              skillId={skillId}
              newProjectsEnvironment={props.newProjectsEnvironment}
              onClose={props.onClose}
            />
          </DialogContent>
        )}
      </Show>
    </Dialog>
  );
}

function ServiceSettingsLoader(props: OpenedServiceSettings) {
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
            newProjectsEnvironment={props.newProjectsEnvironment}
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

function FieldSettingsEditor(props: OpenedServiceSettings & { view: AgentServiceSettingsView }) {
  const { hasPermission } = usePermissions();
  const form = optionalFields(serviceSettingsFormOf(props.view.service.manifest.projectForm ?? []));
  const saved = savedValuesOf(props.view.settings);
  const save = useSetAgentServiceSettings(() => props.agentId);
  const canSet = () => hasPermission('can_configure_project_external_services');
  const editor = useConfigurationForm({
    form,
    initial: withDefaults(form, saved.values),
    missing: [],
    labels: saved.labels,
    submitted: (values, labels) => {
      const kept = settingsWorthKeeping(form, values, saved.values);
      const picked = labels.labelsFor(kept);
      return Object.keys(picked).length > 0 ? { ...kept, [labelsKey]: picked } : kept;
    },
    save: {
      mutateAsync: (values) => save.mutateAsync({ skillId: props.skillId, settings: { values } }),
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

  const clear = async () => {
    try {
      await save.mutateAsync({ skillId: props.skillId, settings: { values: null } });
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'The service settings could not be cleared.');
      return;
    }
    toast.success(`Cleared the service settings of ${props.view.service.displayName}`);
    props.onClose();
  };

  const callService: ServiceCaller = (route, name, request) =>
    route === 'options'
      ? callAgentServiceSettingsOptions(props.agentId, props.skillId, name, {
          values: editor.draftValues(),
          ...request,
        })
      : Promise.reject(new Error('Only choices can be asked for outside a Project'));

  const ctx: FormContext = {
    draft: editor.draft,
    readOnly: () => !canSet() || editor.saving(),
    templateValues: () => ({}),
    serviceConfigurationOptions: serviceConfigurationOptionsIn(() => props.view.serviceConfigurationOptions),
    storedLabel: editor.labels.storedLabel,
    seenOptions: editor.labels.seenOptions,
    get callService() {
      return canSet() ? callService : undefined;
    },
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle class="pr-8">Service settings: {props.view.service.displayName}</DialogTitle>
        <DialogDescription>
          New Projects of the agent start with these settings.{' '}
          {props.view.service.manifest.connectedByDefault ? 'They replace the service defaults. ' : ''}
          Each Project can change its own later; existing Projects keep theirs. Secrets are set per Project.
          <Show when={props.newProjectsEnvironment}>
            {(environment) => (
              <span class="mt-1 block font-medium text-foreground">
                Publish to {environment()} for new Projects to get them.
              </span>
            )}
          </Show>
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
              This service has no settings an agent can carry: its Project form holds only secrets and generated values,
              which each Project gets for itself.
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
          <Show when={canSet() && props.view.settings !== null}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              class="mr-auto text-muted-foreground"
              disabled={editor.saving()}
              onClick={() => void clear()}
            >
              Clear settings
            </Button>
          </Show>
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
