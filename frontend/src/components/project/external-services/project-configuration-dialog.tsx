import { Match, Show, Switch, createSignal, untrack } from 'solid-js';
import { createStore } from 'solid-js/store';
import { callSources } from '~/api/external-service-calls';
import {
  callProjectForm,
  needsAttention,
  useProjectExternalService,
  useDiscardProjectConfigurationHook,
  useRetryProjectConfigurationHook,
  useRotateProjectConfiguration,
  useSaveProjectConfiguration,
  type ProjectEnvironmentRef,
  type ProjectServiceView,
  type Switches,
} from '~/api/project-external-services';
import { usePermissions } from '~/api/permissions';
import { OriginBadge } from '~/components/store/store-list';
import { CallsTable } from '~/components/external-service/calls-table';
import { ServiceIcon } from '~/components/external-service/service-marks';
import {
  ConfigurationFooter,
  createConfigurationEdits,
  useConfigurationForm,
  type ConfigurationEdits,
} from '~/components/external-service-form/configuration-form';
import type { FormContext, ServiceCaller } from '~/components/external-service-form/form-context';
import { ServiceFormFields } from '~/components/external-service-form/form-renderer';
import { withDefaults } from '~/components/external-service-form/form-values';
import { HookFailureNotice, RemovedItemsNoticeBanner } from '~/components/external-service-form/save-notices';
import {
  NeedsAttentionBanner,
  OperationSwitches,
  ReceiveSwitches,
} from '~/components/external-service-form/generated-switches';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '~/components/ui/dialog';
import { Spinner } from '~/components/ui/spinner';
import { ChevronRight, Lock } from '~/components/icons';
import { Permission } from '~/constants/permissions';
import { cn } from '~/lib/cn';

export function ProjectConfigurationDialog(props: {
  environment: ProjectEnvironmentRef;
  environmentName: string;
  serviceId: string | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={props.serviceId !== null} onOpenChange={(open) => !open && props.onClose()}>
      <Show when={props.serviceId} keyed>
        {(serviceId) => (
          <DialogContent class="max-h-[85vh] max-w-xl overflow-y-auto" align="top">
            <ProjectConfigurationLoader
              environment={props.environment}
              environmentName={props.environmentName}
              serviceId={serviceId}
              onClose={props.onClose}
            />
          </DialogContent>
        )}
      </Show>
    </Dialog>
  );
}

function ProjectConfigurationLoader(props: {
  environment: ProjectEnvironmentRef;
  environmentName: string;
  serviceId: string;
  onClose: () => void;
}) {
  const view = useProjectExternalService(
    () => props.environment,
    () => props.serviceId
  );
  return (
    <Switch fallback={<Spinner label="Loading…" />}>
      <Match when={view.error}>
        <p class="text-xs text-destructive" role="alert">
          This service isn't available to this Project any more.
        </p>
      </Match>
      <Match when={view.data}>
        {(loaded) => (
          <ProjectConfigurationPanel
            initial={untrack(loaded)}
            environment={props.environment}
            environmentName={props.environmentName}
            onClose={props.onClose}
          />
        )}
      </Match>
    </Switch>
  );
}

function ProjectConfigurationPanel(props: {
  initial: ProjectServiceView;
  environment: ProjectEnvironmentRef;
  environmentName: string;
  onClose: () => void;
}) {
  const notice = untrack(() => props.initial.notice);
  const rotate = useRotateProjectConfiguration(
    () => props.environment,
    () => props.initial.id
  );
  const retry = useRetryProjectConfigurationHook(
    () => props.environment,
    () => props.initial.id
  );
  const discard = useDiscardProjectConfigurationHook(
    () => props.environment,
    () => props.initial.id
  );
  const edits = createConfigurationEdits(
    untrack(() => props.initial),
    {
      rotate: (target) => rotate.mutateAsync(target),
      retry: () => retry.mutateAsync(undefined),
      discard: () => discard.mutateAsync(undefined),
    }
  );
  const base = edits.base;
  return (
    <>
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2 pr-8">
          <ServiceIcon icon={base().icon} name={base().displayName} class="h-4 w-4" />
          {base().displayName}
          <OriginBadge origin={base().origin} />
        </DialogTitle>
        <DialogDescription>Project configuration for {props.environmentName}</DialogDescription>
      </DialogHeader>
      <Show when={notice}>{(shown) => <RemovedItemsNoticeBanner notice={shown()} />}</Show>
      <Show when={base().state !== 'enabled'}>
        <p class="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <Show
            when={base().state === 'needs-configuration'}
            fallback={<>Not enabled here. Saving enables it in this environment and gives the agent its skill.</>}
          >
            This agent carries the service's skill, but nothing is configured here yet. Saving enables it.
          </Show>
        </p>
      </Show>
      <Show when={base()} keyed>
        {(view) => (
          <ProjectConfigurationEditor
            view={view}
            environment={props.environment}
            edits={edits}
            onClose={props.onClose}
          />
        )}
      </Show>
      <EnvironmentCalls environment={props.environment} serviceId={base().id} />
    </>
  );
}

function EnvironmentCalls(props: { environment: ProjectEnvironmentRef; serviceId: string }) {
  const [open, setOpen] = createSignal(false);
  return (
    <section class="mt-4 border-t border-border pt-3">
      <button
        type="button"
        class="flex w-full items-center gap-1.5 text-left text-xs font-medium text-foreground"
        aria-expanded={open()}
        onClick={() => setOpen(!open())}
      >
        <ChevronRight class={cn('h-3.5 w-3.5 transition-transform', open() && 'rotate-90')} aria-hidden="true" />
        Calls for this environment
      </button>
      <Show when={open()}>
        <div class="mt-3">
          <CallsTable
            source={callSources.projectEnvironment(props.environment, props.serviceId)}
            scope="environment"
            compact
          />
        </div>
      </Show>
    </section>
  );
}

function ProjectConfigurationEditor(props: {
  view: ProjectServiceView;
  environment: ProjectEnvironmentRef;
  edits: ConfigurationEdits<ProjectServiceView>;
  onClose: () => void;
}) {
  const { hasPermission } = usePermissions();
  const form = props.view.manifest.projectForm ?? [];
  const configuration = props.view.projectConfiguration;
  const [operations, setOperations] = createStore<Switches>({ ...configuration.operations });
  const [receive, setReceive] = createStore<Switches>({ ...configuration.receive });
  const switchesBaseline = JSON.stringify({ operations: configuration.operations, receive: configuration.receive });
  const save = useSaveProjectConfiguration(
    () => props.environment,
    () => props.view.id
  );
  const editor = useConfigurationForm({
    form,
    initial: configuration.saved ? configuration.values : withDefaults(form, configuration.values),
    missing: configuration.saved ? configuration.missing : [],
    labels: configuration.labels,
    save,
    submitted: (formValues, labels) => ({
      ...formValues,
      ...(JSON.parse(JSON.stringify({ operations, receive })) as Record<string, unknown>),
      _labels: labels.labelsFor(formValues),
    }),
    onEdit: props.edits.edited,
    onSaved: props.edits.rebase,
    saveFailedMessage: 'The Project configuration could not be saved.',
  });

  const canConfigure = () => hasPermission(Permission.configureProjectExternalServices);
  const readOnly = () => !canConfigure() || editor.saving();
  const isDirty = () => editor.draft.isDirty() || JSON.stringify({ operations, receive }) !== switchesBaseline;

  const callService: ServiceCaller = (route, name, request) =>
    callProjectForm(props.environment, props.view.id, route, name, { values: editor.draftValues(), ...request });

  const ctx: FormContext = {
    draft: editor.draft,
    readOnly,
    templateValues: () => props.view.templateValues,
    serviceConfigurationOptions: (listKey, labelKey) =>
      props.view.serviceConfigurationOptions.find((source) => source.list === listKey && source.labelKey === labelKey)
        ?.options ?? [],
    storedLabel: editor.labels.storedLabel,
    seenOptions: editor.labels.seenOptions,
    get callService() {
      return canConfigure() ? callService : undefined;
    },
    revealed: props.edits.revealed,
    get rotate() {
      return canConfigure() ? props.edits.rotate : undefined;
    },
    pendingGeneratedText: () =>
      Object.keys(props.view.manifest.events ?? {}).length > 0 && !Object.values(receive).some(Boolean)
        ? 'Generated when you save with Receive on.'
        : 'Generated by the platform when you save.',
  };

  return (
    <form
      class="mt-4 flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void editor.submit();
      }}
    >
      <Show when={props.view.hookFailure}>
        {(hookFailure) => (
          <Show when={canConfigure()}>
            <HookFailureNotice failure={hookFailure()} onRetry={props.edits.retry} onDiscard={props.edits.discard} />
          </Show>
        )}
      </Show>
      <Show when={needsAttention(configuration)}>
        <NeedsAttentionBanner serviceName={props.view.displayName} form={form} missing={configuration.missing} />
      </Show>
      <Show when={!canConfigure()}>
        <div class="flex items-center gap-2 rounded-md border border-dashed border-border px-2.5 py-2 text-[11px] text-muted-foreground">
          <Lock class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          You can view this configuration. Changing it needs the "Configure project External Services" permission.
        </div>
      </Show>

      <Show when={form.length > 0}>
        <ServiceFormFields fields={form} ctx={ctx} />
      </Show>

      <OperationSwitches
        manifest={props.view.manifest}
        switches={operations}
        newNames={configuration.newOperations}
        readOnly={readOnly()}
        onChange={(name, on) => {
          editor.edited();
          setOperations(name, on);
        }}
      />
      <ReceiveSwitches
        manifest={props.view.manifest}
        switches={receive}
        newNames={configuration.newEventTypes}
        readOnly={readOnly()}
        onChange={(type, on) => {
          editor.edited();
          setReceive(type, on);
        }}
      />

      <ConfigurationFooter
        compact
        saving={editor.saving()}
        failure={editor.failure()}
        saved={props.edits.saved() && !props.view.hookFailure ? 'Saved.' : null}
        hint={!props.edits.saved() && canConfigure() && isDirty() ? 'Unsaved changes' : null}
        canSave={canConfigure()}
        cancel={{ label: canConfigure() ? 'Cancel' : 'Close', onClick: () => props.onClose() }}
      />
    </form>
  );
}
