import { createFileRoute } from '@tanstack/solid-router';
import { ExternalServicesListPage, validateExternalServicesSearch } from '~/pages/store/external-services-list';

export const Route = createFileRoute('/store/external-services/')({
  component: StoreExternalServices,
  validateSearch: validateExternalServicesSearch,
});

function StoreExternalServices() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  return (
    <ExternalServicesListPage
      filter={search().filter}
      query={search().q}
      onFilter={(filter) => navigate({ search: (prev) => ({ ...prev, filter }), replace: true })}
      onQuery={(q) => navigate({ search: (prev) => ({ ...prev, q }), replace: true })}
    />
  );
}
