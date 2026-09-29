import { createFileRoute, type SearchSchemaInput } from '@tanstack/solid-router';
import { AgentPage } from '~/pages/store/agent-page';

export interface AgentPageSearch {
  env: string;
  skill?: string;
}

export const Route = createFileRoute('/store/agents/$id/')({
  component: StoreAgent,
  validateSearch: (search: Record<string, unknown> & SearchSchemaInput): AgentPageSearch => ({
    env: typeof search.env === 'string' ? search.env : '',
    ...(typeof search.skill === 'string' && search.skill ? { skill: search.skill } : {}),
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
      fromSkillId={search().skill}
      onEnv={(env) => navigate({ search: (prev) => ({ ...prev, env }), replace: true })}
    />
  );
}
