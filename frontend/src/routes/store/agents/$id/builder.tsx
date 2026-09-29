import { Show } from 'solid-js';
import { createFileRoute } from '@tanstack/solid-router';
import { BuilderPage } from '~/pages/store/builder-page';

export const Route = createFileRoute('/store/agents/$id/builder')({
  validateSearch: (search: Record<string, unknown>): { env?: string } =>
    typeof search.env === 'string' && search.env ? { env: search.env } : {},
  component: AgentBuilder,
});

function AgentBuilder() {
  const params = Route.useParams();
  const search = Route.useSearch();
  return (
    <Show when={params().id} keyed>
      {(id) => <BuilderPage subject={{ type: 'agent', id }} returnEnv={search().env} />}
    </Show>
  );
}
