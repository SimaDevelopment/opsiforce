import { createFileRoute } from '@tanstack/solid-router';
import { ModelProvidersPage } from '~/pages/model-providers/model-providers-page';

export const Route = createFileRoute('/settings/model-providers')({
  component: ModelProvidersPage,
});
