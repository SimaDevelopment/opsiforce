import { Match, Show, Switch, createSignal, untrack } from 'solid-js';
import { toast } from 'solid-sonner';
import { callLogSources } from '~/api/external-service-call-log';
import {
  callProjectForm,
  needsAttention,
  useProjectExternalService,
  useDisconnectProjectService,
  useDiscardProjectConfigurationHook,
  useRetryProjectConfigurationHook,
  useRotateProjectConfiguration,
  useSaveProjectConfiguration,
  type ProjectEnvironmentRef,
  type ProjectServiceView,
} from '~/api/project-external-services';
import { usePermissions } from '~/api/permissions';
import { OriginBadge } from '~/components/store/store-list';
import { CallLog } from '~/components/external-service/call-log';
import { ServiceIcon } from '~/components/external-service/service-marks';
import { EventDeliveryStatusLines } from './event-delivery-status';
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
import { NeedsAttentionBanner } from '~/components/external-service-form/needs-attention-banner';
import { Button } from '~/components/ui/button';
import { ConfirmDialog } from '~/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '~/components/ui/dialog';
import { Spinner } from '~/components/ui/spinner';
import { ChevronRight, Lock, Unplug } from '~/components/icons';
import { cn } from '~/lib/cn';

export function ProjectConfigurationDialog(props: {
  environment: ProjectEnvironmentRef;
  environmentName: string;
  serviceId: string | null;
  focusedField?: string;
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
              focusedField={props.focusedField}
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
  focusedField?: string;
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
            focusedField={props.focusedField}
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
  focusedField?: string;
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
        <DialogDescription>{props.environmentName} environment</DialogDescription>
      </DialogHeader>
      <Show when={notice}>{(shown) => <RemovedItemsNoticeBanner notice={shown()} />}</Show>
      <Show when={base()} keyed>
        {(view) => (
          <ProjectConfigurationEditor
            view={view}
            environment={props.environment}
            edits={edits}
            focusedField={props.focusedField}
            onClose={props.onClose}
          />
        )}
      </Show>
      <Show when={base().manifest.inbound === true && base().state === 'enabled'}>
        <EventDeliveryStatusLines environment={props.environment} serviceId={base().id} />
      </Show>
      <Show when={base().projectConfiguration.saved}>
        <DisconnectSection
          environment={props.environment}
          environmentName={props.environmentName}
          serviceId={base().id}
          serviceName={base().displayName}
          onDisconnected={props.onClose}
        />
      </Show>
      <EnvironmentCalls environment={props.environment} serviceId={base().id} />
    </>
  );
}

function DisconnectSection(props: {
  environment: ProjectEnvironmentRef;
  environmentName: string;
  serviceId: string;
  serviceName: string;
  onDisconnected: () => void;
}) {
  const { hasPermission } = usePermissions();
  const canDisconnect = () =>
    hasPermission('can_configure_project_external_services') || hasPermission('can_manage_tenant_external_services');
  const disconnect = useDisconnectProjectService(
    () => props.environment,
    () => props.serviceId
  );
  const [confirming, setConfirming] = createSignal(false);
  const confirm = () =>
    disconnect.mutate(undefined, {
      onSuccess: () => {
        toast.success(`Disconnected ${props.serviceName} from ${props.environmentName}`);
        props.onDisconnected();
      },
      onError: () => toast.error(`Failed to disconnect ${props.serviceName}`),
    });
  return (
    <Show when={canDisconnect()}>
      <section class="mt-4 flex items-center justify-between gap-3 border-t border-border pt-3">
        <p class="text-xs text-muted-foreground">
          Disconnect deletes this environment's configuration; its calls are refused as not connected within seconds.
        </p>
        <Button
          size="sm"
          variant="outline"
          class="shrink-0"
          loading={disconnect.isPending}
          onClick={() => setConfirming(true)}
        >
          <Unplug class="h-3.5 w-3.5" aria-hidden="true" />
          Disconnect
        </Button>
      </section>
      <ConfirmDialog
        open={confirming()}
        onOpenChange={setConfirming}
        title={`Disconnect ${props.serviceName}?`}
        description={`${props.environmentName} loses its configuration of ${props.serviceName}, and the service refuses its calls as not connected within seconds. Reconnecting means filling the form again.`}
        confirmLabel="Disconnect"
        variant="destructive"
        onConfirm={confirm}
      />
    </Show>
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
          <CallLog source={callLogSources.projectEnvironment(props.environment, props.serviceId)} compact />
        </div>
      </Show>
    </section>
  );
}

function ProjectConfigurationEditor(props: {
  view: ProjectServiceView;
  environment: ProjectEnvironmentRef;
  edits: ConfigurationEdits<ProjectServiceView>;
  focusedField?: string;
  onClose: () => void;
}) {
  const { hasPermission } = usePermissions();
  const form = props.view.manifest.projectForm ?? [];
  const configuration = props.view.projectConfiguration;
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
    submitted: (formValues, labels) => ({ ...formValues, _labels: labels.labelsFor(formValues) }),
    onEdit: props.edits.edited,
    onSaved: (next) => {
      const connecting = props.view.state !== 'enabled';
      props.edits.rebase(next);
      if (next.hookFailure) return;
      toast.success(connecting ? `Connected ${next.displayName}` : `Saved ${next.displayName} settings`);
      if (!next.revealed?.length) props.onClose();
    },
    saveFailedMessage: 'The Project configuration could not be saved.',
  });

  const canConfigure = () => hasPermission('can_configure_project_external_services');
  const readOnly = () => !canConfigure() || editor.saving();
  const isDirty = () => editor.draft.isDirty();

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
    pendingGeneratedText: () => 'Generated by the platform when you save.',
    focusedField: props.focusedField,
  };

  const scrollToFocusedField = (formElement: HTMLFormElement) => {
    const key = props.focusedField;
    if (!key) return;
    requestAnimationFrame(() =>
      formElement.querySelector(`[data-field-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'center' })
    );
  };

  return (
    <form
      ref={scrollToFocusedField}
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
          You can view this configuration. An Organization admin, or anyone with the "Configure project External
          Services" permission, can change it.
        </div>
      </Show>

      <Show when={form.length > 0}>
        <ServiceFormFields fields={form} ctx={ctx} />
      </Show>

      <ConfigurationFooter
        compact
        saving={editor.saving()}
        failure={editor.failure()}
        hint={!props.edits.saved() && canConfigure() && isDirty() ? 'Unsaved changes' : null}
        canSave={canConfigure()}
        saveLabel={props.view.state === 'enabled' ? 'Save' : 'Connect'}
        cancel={{ label: canConfigure() ? 'Cancel' : 'Close', onClick: () => props.onClose() }}
      />
    </form>
  );
}
