import { createFileRoute } from '@tanstack/solid-router';
import { BuilderListPage } from '~/pages/store/builder-list';
import { validateBuilderSearch } from '~/pages/store/store-filters';

export const Route = createFileRoute('/store/builder/')({
  component: StoreBuilder,
  validateSearch: validateBuilderSearch,
});

function StoreBuilder() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  return (
    <BuilderListPage
      filter={search().filter}
      onFilter={(filter) => navigate({ search: () => ({ filter }), replace: true })}
    />
  );
}
