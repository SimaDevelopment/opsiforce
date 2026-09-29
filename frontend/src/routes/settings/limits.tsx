import { createFileRoute } from '@tanstack/solid-router';
import { LimitsPage } from '~/pages/limits';

export const Route = createFileRoute('/settings/limits')({
  component: LimitsPage,
});
