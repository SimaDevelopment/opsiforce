import { Show } from 'solid-js';
import { useEventDeliveryStatus, type ProjectEnvironmentRef } from '~/api/project-external-services';
import { AlertTriangle } from '~/components/icons';

function eventsWaiting(count: number): string {
  if (count === 0) return 'The App has taken every Event.';
  return `${count} Event${count === 1 ? '' : 's'} not yet taken by the App`;
}

export function EventDeliveryStatusLines(props: { environment: ProjectEnvironmentRef; serviceId: string }) {
  const status = useEventDeliveryStatus(
    () => props.environment,
    () => props.serviceId
  );
  return (
    <Show when={status.data}>
      {(shown) => (
        <section class="mt-4 flex flex-col gap-1.5 border-t border-border pt-3 text-xs">
          <p class="font-medium text-foreground">Events</p>
          <p class="text-muted-foreground">{eventsWaiting(shown().notYetTaken)}</p>
          <Show when={shown().appNotWired}>
            <p class="flex items-start gap-1.5 text-amber-700">
              <AlertTriangle class="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>
                App not wired: the App has no route for this service's Events doorbell yet. Events wait here until the
                App serves it; the doorbell rings again when the App next starts, or now if you restart this
                environment.
              </span>
            </p>
          </Show>
        </section>
      )}
    </Show>
  );
}
