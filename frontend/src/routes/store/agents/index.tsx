import { createFileRoute } from '@tanstack/solid-router';
import { AgentsListPage } from '~/pages/store/agents-list';
import { validateStoreSearch } from '~/pages/store/store-filters';

export const Route = createFileRoute('/store/agents/')({
  component: StoreAgents,
  validateSearch: validateStoreSearch,
});

function StoreAgents() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  return (
    <AgentsListPage
      filter={search().filter}
      query={search().q}
      onFilter={(filter) => navigate({ search: (prev) => ({ ...prev, filter }), replace: true })}
      onQuery={(q) => navigate({ search: (prev) => ({ ...prev, q }), replace: true })}
    />
  );
}
