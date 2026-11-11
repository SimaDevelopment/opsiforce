import { createFileRoute } from '@tanstack/solid-router';
import { ResourcesPage } from '~/pages/resources';

export const Route = createFileRoute('/settings/resources')({
  component: ResourcesPage,
});
