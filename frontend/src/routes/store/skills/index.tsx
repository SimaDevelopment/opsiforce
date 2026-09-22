import { createFileRoute } from '@tanstack/solid-router';
import { SkillsListPage } from '~/pages/store/skills-list';
import { validateStoreSearch } from '~/pages/store/store-filters';

export const Route = createFileRoute('/store/skills/')({
  component: StoreSkills,
  validateSearch: validateStoreSearch,
});

function StoreSkills() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  return (
    <SkillsListPage
      filter={search().filter}
      query={search().q}
      onFilter={(filter) => navigate({ search: (prev) => ({ ...prev, filter }), replace: true })}
      onQuery={(q) => navigate({ search: (prev) => ({ ...prev, q }), replace: true })}
    />
  );
}
