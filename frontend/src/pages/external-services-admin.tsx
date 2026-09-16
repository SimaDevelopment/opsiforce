import { createMemo, Index, Show } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { useExternalServices } from '~/api/external-services';
import { EXTERNAL_SERVICE_UI } from '~/components/external-services/service-registry';
import { Skeleton } from '~/components/ui/skeleton';
import { Cable, RefreshCw } from '~/components/icons';
import { cn } from '~/lib/cn';

export function ExternalServicesAdminPage() {
  const services = useExternalServices();

  const sections = createMemo(() =>
    (services.data ?? []).flatMap((service) => {
      const AdminSection = EXTERNAL_SERVICE_UI[service.name]?.AdminSection;
      return AdminSection ? [{ service, AdminSection }] : [];
    })
  );

  return (
    <div class="h-full w-full overflow-y-auto px-4 py-6">
      <div class="mb-1 flex items-center gap-3">
        <Cable class="h-5 w-5 text-muted-foreground" />
        <h1 class="text-xl font-semibold">External services</h1>
        <button
          type="button"
          onClick={() => services.refetch()}
          class="ml-auto inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          aria-label="Refresh external services"
        >
          <RefreshCw class={cn('h-3.5 w-3.5', services.isFetching && 'animate-spin')} />
        </button>
      </div>

      <p class="mb-5 ml-8 text-xs text-muted-foreground">
        Platform-wide resources shared by every environment. Per-environment wiring lives on the project page, in the
        environment dropdown.
      </p>

      <Show when={!services.isPending} fallback={<Skeleton class="h-24 w-full" />}>
        <Show
          when={!services.isError}
          fallback={<p class="text-sm text-muted-foreground">Could not load the external services list.</p>}
        >
          <div class="space-y-6">
            <Index each={sections()}>
              {(entry) => (
                <section class="space-y-2">
                  <h2 class="text-sm font-semibold">{entry().service.displayName}</h2>
                  <Dynamic component={entry().AdminSection} />
                </section>
              )}
            </Index>
          </div>
        </Show>
      </Show>
    </div>
  );
}
