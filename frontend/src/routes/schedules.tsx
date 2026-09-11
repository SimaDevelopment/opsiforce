import { createFileRoute } from '@tanstack/solid-router';
import { SchedulesPage } from '~/pages/schedules';

interface SchedulesSearch {
  environmentId?: string;
  projectEnvironmentId?: string;
  projectId?: string;
}

export const Route = createFileRoute('/schedules')({
  component: SchedulesPage,
  validateSearch: (search: Record<string, unknown>): SchedulesSearch => ({
    environmentId: typeof search.environmentId === 'string' ? search.environmentId : undefined,
    projectEnvironmentId: typeof search.projectEnvironmentId === 'string' ? search.projectEnvironmentId : undefined,
    projectId: typeof search.projectId === 'string' ? search.projectId : undefined,
  }),
});
