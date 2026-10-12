import { createFileRoute, type SearchSchemaInput } from '@tanstack/solid-router';
import { ExternalServicePage } from '~/pages/store/external-service-page';

export interface ExternalServicePageSearch {
  tab?: string;
  env?: string;
}

export const Route = createFileRoute('/store/external-services/$id/')({
  component: StoreExternalService,
  validateSearch: (search: Record<string, unknown> & SearchSchemaInput): ExternalServicePageSearch => ({
    ...(typeof search.tab === 'string' && search.tab ? { tab: search.tab } : {}),
    ...(typeof search.env === 'string' && search.env ? { env: search.env } : {}),
  }),
});

function StoreExternalService() {
  const params = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  return (
    <ExternalServicePage
      serviceId={params().id}
      tab={search().tab}
      env={search().env}
      onTab={(tab) => navigate({ search: (prev) => ({ ...prev, tab }), replace: true })}
      onEnv={(env) => navigate({ search: (prev) => ({ ...prev, env }), replace: true })}
    />
  );
}
