import { Show } from 'solid-js';
import { createFileRoute } from '@tanstack/solid-router';
import { BuilderPage } from '~/pages/store/builder-page';

export const Route = createFileRoute('/store/external-services/$id/builder')({
  component: ExternalServiceBuilder,
});

function ExternalServiceBuilder() {
  const params = Route.useParams();
  return (
    <Show when={params().id} keyed>
      {(id) => <BuilderPage subject={{ type: 'external_service', id }} />}
    </Show>
  );
}
