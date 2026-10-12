import { For, Show, createSignal } from 'solid-js';
import { useNavigate } from '@tanstack/solid-router';
import { ApiError } from '~/api/client';
import { useDeleteCustomService, useServiceConsumers, useSwitchCustomService } from '~/api/external-service-views';
import { Pager, createOffsetPages } from '~/components/pager';
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

const INPUT_CLASS =
  'flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 font-mono text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

interface LifecycleTarget {
  id: string;
  slug: string;
  displayName: string;
}

export function DisableServiceDialog(props: {
  service: LifecycleTarget;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const switchService = useSwitchCustomService(() => props.service.id);
  const [error, setError] = createSignal<string | null>(null);

  const close = () => {
    setError(null);
    props.onOpenChange(false);
  };

  const disable = async () => {
    setError(null);
    try {
      await switchService.mutateAsync('disable');
      close();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The service could not be disabled.');
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={(open) => (open ? props.onOpenChange(true) : close())}>
      <DialogContent class="max-w-md">
        <DialogHeader>
          <DialogTitle>Disable {props.service.displayName}?</DialogTitle>
          <DialogDescription>
            Its pods stop and every call answers that the service is disabled. Projects stop seeing it, and its webhooks
            are refused. Every configuration is kept, so Enable brings it back as it was.
          </DialogDescription>
        </DialogHeader>
        <Show when={error()}>
          <p class="text-xs text-destructive" role="alert">
            {error()}
          </p>
        </Show>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button size="sm" variant="destructive" loading={switchService.isPending} onClick={() => void disable()}>
            Disable
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DeleteServiceDialog(props: {
  service: LifecycleTarget;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const consumers = useServiceConsumers(
    () => props.service.id,
    () => props.open
  );
  const consumerPages = createOffsetPages(() => consumers.data ?? []);
  const deleteService = useDeleteCustomService(() => props.service.id);
  const [typed, setTyped] = createSignal('');
  const [error, setError] = createSignal<string | null>(null);

  const canDelete = () => typed() === props.service.slug && !deleteService.isPending;

  const close = () => {
    setTyped('');
    setError(null);
    props.onOpenChange(false);
  };

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!canDelete()) return;
    setError(null);
    try {
      await deleteService.mutateAsync(typed());
      close();
      void navigate({ to: '/store/external-services' });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The service could not be deleted.');
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={(open) => (open ? props.onOpenChange(true) : close())}>
      <DialogContent class="max-w-md">
        <form onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>Delete {props.service.displayName}?</DialogTitle>
            <DialogDescription>
              This removes the service, its builder chat, every configuration and everything it stored. Its Calls stay
              in the log. Agents and Apps that call it get "unknown service", and the slug is free again.
            </DialogDescription>
          </DialogHeader>

          <div class="mt-4 flex flex-col gap-4">
            <section>
              <h3 class="mb-1.5 text-xs font-medium text-muted-foreground">Used in</h3>
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
                  fallback={<p class="text-xs text-muted-foreground">No Project uses this service.</p>}
                >
                  <ul class="max-h-40 overflow-y-auto rounded-md border border-border text-xs">
                    <For each={consumerPages.page()}>
                      {(consumer) => (
                        <li class="flex items-center justify-between gap-3 border-b border-border px-3 py-1.5 last:border-b-0">
                          <span class="min-w-0 truncate">{consumer.projectTitle ?? 'Untitled Project'}</span>
                          <span class="shrink-0 text-muted-foreground">{consumer.environmentName ?? 'Default'}</span>
                        </li>
                      )}
                    </For>
                  </ul>
                  <Show when={consumerPages.needsPager()}>
                    <Pager {...consumerPages.pagerProps()} />
                  </Show>
                  <p class="mt-1.5 text-xs text-muted-foreground">
                    The service is told about each one before it goes; a service that does not answer is deleted anyway.
                  </p>
                </Show>
              </Show>
            </section>

            <div>
              <label for="delete-external-service-slug" class="mb-1 block text-xs font-medium text-muted-foreground">
                Type <span class="font-mono text-foreground">{props.service.slug}</span> to confirm
              </label>
              <input
                id="delete-external-service-slug"
                name="confirmSlug"
                type="text"
                autocomplete="off"
                spellcheck={false}
                value={typed()}
                onInput={(event) => {
                  setTyped(event.currentTarget.value);
                  setError(null);
                }}
                class={INPUT_CLASS}
              />
            </div>
            <Show when={error()}>
              <p class="text-xs text-destructive" role="alert">
                {error()}
              </p>
            </Show>
          </div>

          <DialogFooter class="mt-4">
            <Button type="button" size="sm" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              variant="destructive"
              disabled={!canDelete()}
              loading={deleteService.isPending}
            >
              Delete
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
