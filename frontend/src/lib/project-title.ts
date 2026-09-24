import type { Project } from '~/api/client';

export function projectTitleOf(project: Project | undefined | null): string {
  return project?.title?.trim() || 'Untitled project';
}
