import { Index, Show } from 'solid-js';
import { useExternalServices } from '~/api/external-services';
import type { ProjectEnvironment } from '~/api/environments';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '~/components/ui/dialog';
import { Skeleton } from '~/components/ui/skeleton';
import { EnvironmentServiceSection } from './environment-service-section';

export function ExternalServicesDialog(props: {
  environment: ProjectEnvironment | null;
  onOpenChange: (open: boolean) => void;
}) {
  const open = () => props.environment !== null;
  const environmentId = () => props.environment?.id ?? '';

  const services = useExternalServices({ enabled: open });

  return (
    <Dialog open={open()} onOpenChange={props.onOpenChange}>
      <DialogContent class="max-w-lg">
        <DialogHeader>
          <DialogTitle>External services</DialogTitle>
          <DialogDescription>
            Inbound channels wired to {props.environment?.name ?? 'this environment'}. Messages that arrive here are
            stored for the environment and the running app is notified.
          </DialogDescription>
        </DialogHeader>

        <div class="mt-4 max-h-[60vh] space-y-5 overflow-y-auto">
          <Show when={!services.isPending} fallback={<Skeleton class="h-24 w-full" />}>
            <Show
              when={!services.isError}
              fallback={<p class="text-xs text-destructive">Could not load the external services list.</p>}
            >
              <Index each={services.data ?? []}>
                {(service) => <EnvironmentServiceSection service={service()} projectEnvironmentId={environmentId()} />}
              </Index>
            </Show>
          </Show>
        </div>
      </DialogContent>
    </Dialog>
  );
}
