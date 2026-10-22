import { Show, createEffect, createSignal, on, untrack } from 'solid-js';
import { toast } from 'solid-sonner';
import { ApiError } from '~/api/client';
import {
  callDevelopmentServiceForm,
  useCopyProductionToDevelopment,
  useDevelopmentService,
  useDiscardDevelopmentConfigurationHook,
  useRetryDevelopmentConfigurationHook,
  useRotateDevelopmentConfiguration,
  useSaveDevelopmentConfiguration,
  type DevelopmentServiceView,
} from '~/api/external-service-views';
import {
  ConfigurationFooter,
  createConfigurationEdits,
  useConfigurationForm,
  type ConfigurationEdits,
} from '~/components/external-service-form/configuration-form';
import type { FormContext } from '~/components/external-service-form/form-context';
import { CopyButton } from '~/components/external-service-form/copy-button';
import { ServiceFormFields } from '~/components/external-service-form/form-renderer';
import { storedOrDefaults } from '~/components/external-service-form/form-values';
import { HookFailureNotice } from '~/components/external-service-form/save-notices';
import { Button } from '~/components/ui/button';
import { ConfirmDialog } from '~/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '~/components/ui/dialog';
import { Spinner } from '~/components/ui/spinner';

export function DevelopmentConfigurationDialog(props: { serviceId: string; open: boolean; onClose: () => void }) {
  const view = useDevelopmentService(
    () => props.serviceId,
    () => props.open
  );
  const [openedAt, setOpenedAt] = createSignal(0);
  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return;
        setOpenedAt(Date.now());
        void view.refetch();
      }
    )
  );
  const readSinceOpening = () => (view.data && view.dataUpdatedAt >= openedAt() ? view.data : undefined);

  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent class="max-h-[85vh] max-w-xl overflow-y-auto" align="top">
        <DialogHeader>
          <DialogTitle>Development configuration</DialogTitle>
          <DialogDescription>
            What this chat's Test Project reaches when it calls the service. Callers in your Projects keep using the
            published configuration; publishing never copies this one.
          </DialogDescription>
        </DialogHeader>
        <Show
          when={readSinceOpening()}
          fallback={
            <Show
              when={view.isError}
              fallback={
                <div class="flex justify-center py-8">
                  <Spinner />
                </div>
              }
            >
              <p class="text-sm text-muted-foreground" role="alert">
                {view.error instanceof ApiError
                  ? view.error.message
                  : 'The Development configuration could not be read.'}
              </p>
            </Show>
          }
        >
          {(loaded) => (
            <DevelopmentEditor serviceId={props.serviceId} initial={untrack(loaded)} onClose={props.onClose} />
          )}
        </Show>
      </DialogContent>
    </Dialog>
  );
}

function DevelopmentEditor(props: { serviceId: string; initial: DevelopmentServiceView; onClose: () => void }) {
  const [confirmingCopy, setConfirmingCopy] = createSignal(false);
  const copy = useCopyProductionToDevelopment(() => props.serviceId);
  const rotate = useRotateDevelopmentConfiguration(() => props.serviceId);
  const retry = useRetryDevelopmentConfigurationHook(() => props.serviceId);
  const discard = useDiscardDevelopmentConfigurationHook(() => props.serviceId);
  const edits = createConfigurationEdits(props.initial, {
    rotate: (target) => rotate.mutateAsync(target),
    retry: () => retry.mutateAsync(undefined),
    discard: () => discard.mutateAsync(undefined),
  });

  return (
    <div class="flex flex-col gap-4">
      <Show when={edits.base().manifest.inbound ? edits.base().webhookUrl : null}>
        {(url) => (
          <div class="rounded-lg border border-border bg-muted/40 p-3 text-xs">
            <p class="mb-1 font-medium text-foreground">Development webhook URL</p>
            <div class="flex items-center gap-2">
              <code class="min-w-0 flex-1 truncate">{url()}</code>
              <CopyButton text={url()} label="Copy webhook URL" />
            </div>
            <p class="mt-1 text-muted-foreground">Events sent here reach only this chat's Test Project.</p>
          </div>
        )}
      </Show>
      <div class="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={!edits.base().production.saved}
          loading={copy.isPending}
          onClick={() => setConfirmingCopy(true)}
        >
          Copy from Production
        </Button>
        <Show when={!edits.base().production.saved}>
          <span class="text-xs text-muted-foreground">
            Nothing to copy: the published configuration is not saved yet.
          </span>
        </Show>
      </div>
      <ConfirmDialog
        open={confirmingCopy()}
        onOpenChange={setConfirmingCopy}
        title="Copy from Production?"
        description="Development's values are replaced by the ones your Projects use. Secrets are sealed again for Development; the published configuration is not touched."
        confirmLabel="Copy"
        onConfirm={() =>
          copy.mutate(undefined, {
            onSuccess: (next) => {
              edits.rebase(next);
              toast.success('Copied the Production configuration into Development');
            },
            onError: (error) => toast.error(error.message || 'The configuration could not be copied.'),
          })
        }
      />
      <Show when={edits.base()} keyed>
        {(view) => (
          <DevelopmentForm
            serviceId={props.serviceId}
            view={view}
            edits={edits}
            onSaved={(next) => {
              edits.rebase(next);
              if (next.hookFailure) return;
              toast.success('Saved the Development configuration');
              if (!next.revealed?.length) props.onClose();
            }}
            onEdit={edits.edited}
          />
        )}
      </Show>
    </div>
  );
}

function DevelopmentForm(props: {
  serviceId: string;
  view: DevelopmentServiceView;
  edits: ConfigurationEdits<DevelopmentServiceView>;
  onSaved: (view: DevelopmentServiceView) => void;
  onEdit: () => void;
}) {
  const form = props.view.manifest.serviceForm ?? [];
  const stored = props.view.serviceConfiguration.values;
  const save = useSaveDevelopmentConfiguration(() => props.serviceId);
  const configuration = useConfigurationForm({
    form,
    initial: storedOrDefaults(form, stored),
    missing: props.view.serviceConfiguration.missing,
    save,
    onEdit: props.onEdit,
    onSaved: props.onSaved,
    saveFailedMessage: 'The Development configuration could not be saved.',
  });

  const ctx: FormContext = {
    draft: configuration.draft,
    readOnly: configuration.saving,
    templateValues: () => ({ webhookUrl: props.view.webhookUrl ?? '' }),
    serviceConfigurationOptions: () => [],
    storedLabel: configuration.labels.storedLabel,
    seenOptions: configuration.labels.seenOptions,
    callService: (route, name, request) =>
      callDevelopmentServiceForm(props.serviceId, route, name, { values: configuration.draftValues(), ...request }),
    revealed: props.edits.revealed,
    rotate: props.edits.rotate,
  };

  return (
    <Show
      when={form.length > 0}
      fallback={<p class="text-xs text-muted-foreground">Development's service.json has nothing to configure.</p>}
    >
      <Show when={props.view.hookFailure}>
        {(hookFailure) => (
          <HookFailureNotice failure={hookFailure()} onRetry={props.edits.retry} onDiscard={props.edits.discard} />
        )}
      </Show>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void configuration.submit();
        }}
      >
        <ServiceFormFields fields={form} ctx={ctx} />
        <ConfigurationFooter
          saving={configuration.saving()}
          failure={configuration.failure()}
          hint={
            props.view.serviceConfiguration.missing.length > 0
              ? "Until the required fields are filled, the Test Project's calls that need them fail."
              : null
          }
        />
      </form>
    </Show>
  );
}
