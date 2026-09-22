import { createFileRoute, type SearchSchemaInput } from '@tanstack/solid-router';
import { AgentPage } from '~/pages/store/agent-page';

export interface AgentPageSearch {
  /** The Environment whose panel is open. Empty means Development, which the page resolves. */
  env: string;
}

export const Route = createFileRoute('/store/agents/$id')({
  component: StoreAgent,
  validateSearch: (search: Record<string, unknown> & SearchSchemaInput): AgentPageSearch => ({
    env: typeof search.env === 'string' ? search.env : '',
  }),
});

function StoreAgent() {
  const params = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  return (
    <AgentPage
      agentId={params().id}
      env={search().env}
      onEnv={(env) => navigate({ search: (prev) => ({ ...prev, env }), replace: true })}
    />
  );
}
