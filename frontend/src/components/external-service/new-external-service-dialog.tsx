import { Show, createSignal } from 'solid-js';
import { useNavigate } from '@tanstack/solid-router';
import { builderPath } from '~/api/builder';
import { ApiError } from '~/api/client';
import { useCreateCustomService } from '~/api/external-service-views';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { ServiceNameFields, createServiceNaming } from './service-name-fields';

export function NewExternalServiceDialog(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate();
  const createService = useCreateCustomService();
  const naming = createServiceNaming();
  const [error, setError] = createSignal<string | null>(null);

  const canSubmit = () => naming.valid() && !createService.isPending;

  const close = () => {
    naming.reset();
    setError(null);
    props.onOpenChange(false);
  };

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!canSubmit()) return;
    setError(null);
    try {
      const service = await createService.mutateAsync({ name: naming.name().trim(), slug: naming.slug() });
      close();
      void navigate({ to: builderPath({ type: 'external_service', id: service.id }) });
    } catch (caught) {
      if (naming.placeSlugRefusal(caught)) return;
      setError(caught instanceof ApiError ? caught.message : 'The External Service could not be created.');
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={(open) => (open ? props.onOpenChange(true) : close())}>
      <DialogContent>
        <form onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>New External Service</DialogTitle>
            <DialogDescription>
              Name it, then describe it to the External Service Builder. You approve its forms and the requests it lets
              through before it writes them, and you publish it when it is ready.
            </DialogDescription>
          </DialogHeader>

          <div class="mt-4 flex flex-col gap-4">
            <ServiceNameFields id="new-external-service" naming={naming} onEdit={() => setError(null)} />
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
            <Button type="submit" size="sm" disabled={!canSubmit()} loading={createService.isPending}>
              Create and open the chat
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
