import { For, Show, createSignal } from 'solid-js';
import { toast } from 'solid-sonner';
import { useDisconnectServiceConsumer, useServiceConsumers, type ServiceConsumer } from '~/api/external-service-views';
import { Unplug } from '~/components/icons';
import { Pager, createOffsetPages } from '~/components/pager';
import { SectionTitle } from '~/components/store/store-list';
import { Button } from '~/components/ui/button';
import { ConfirmDialog } from '~/components/ui/confirm-dialog';
import { Spinner } from '~/components/ui/spinner';

function consumerName(consumer: ServiceConsumer): string {
  return `${consumer.projectTitle ?? 'Untitled Project'} · ${consumer.environmentName ?? 'Default'}`;
}

export function ConnectedProjects(props: { serviceId: string; serviceName: string }) {
  const consumers = useServiceConsumers(
    () => props.serviceId,
    () => true
  );
  const pages = createOffsetPages(() => consumers.data ?? []);
  const disconnect = useDisconnectServiceConsumer(() => props.serviceId);
  const [pending, setPending] = createSignal<ServiceConsumer | null>(null);
  const pendingName = () => {
    const consumer = pending();
    return consumer ? consumerName(consumer) : '';
  };

  const confirm = () => {
    const consumer = pending();
    if (!consumer) return;
    disconnect.mutate(consumer.projectEnvironmentId, {
      onSuccess: () => toast.success(`Disconnected ${consumerName(consumer)}`),
      onError: () => toast.error(`Failed to disconnect ${consumerName(consumer)}`),
    });
  };

  return (
    <section>
      <SectionTitle>Connected Projects</SectionTitle>
      <Show
        when={!consumers.isLoading}
        fallback={
          <div class="flex justify-center py-2">
            <Spinner />
          </div>
        }
      >
        <Show
          when={(consumers.data ?? []).length > 0}
          fallback={<p class="text-xs text-muted-foreground">No Project environment is connected to this service.</p>}
        >
          <ul class="rounded-xl border border-border text-xs">
            <For each={pages.page()}>
              {(consumer) => (
                <li class="flex items-center justify-between gap-3 border-b border-border px-3 py-2 last:border-b-0">
                  <span class="min-w-0 truncate">{consumer.projectTitle ?? 'Untitled Project'}</span>
                  <span class="flex shrink-0 items-center gap-3">
                    <span class="text-muted-foreground">{consumer.environmentName ?? 'Default'}</span>
                    <Button
                      size="sm"
                      variant="outline"
                      class="h-7 px-2.5"
                      loading={disconnect.isPending && disconnect.variables === consumer.projectEnvironmentId}
                      onClick={() => setPending(consumer)}
                    >
                      <Unplug class="h-3.5 w-3.5" aria-hidden="true" />
                      Disconnect
                    </Button>
                  </span>
                </li>
              )}
            </For>
          </ul>
          <Show when={pages.needsPager()}>
            <Pager {...pages.pagerProps()} />
          </Show>
        </Show>
      </Show>
      <ConfirmDialog
        open={pending() !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        title={`Disconnect ${pending()?.projectTitle ?? 'this Project'}?`}
        description={`${pendingName()} loses its configuration of ${props.serviceName}, and the service refuses its calls as not connected within seconds. Reconnecting means filling the form again.`}
        confirmLabel="Disconnect"
        variant="destructive"
        onConfirm={confirm}
      />
    </section>
  );
}
