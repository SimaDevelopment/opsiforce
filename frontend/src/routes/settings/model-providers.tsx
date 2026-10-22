import { createFileRoute } from '@tanstack/solid-router';
import { ModelProvidersPage } from '~/pages/model-providers/model-providers-page';

interface ModelProvidersSearch {
  routing?: 'apps';
}

export const Route = createFileRoute('/settings/model-providers')({
  component: ModelProvidersPage,
  validateSearch: (search: Record<string, unknown>): ModelProvidersSearch => ({
    routing: search.routing === 'apps' ? 'apps' : undefined,
  }),
});
