import type { ProjectEnvironmentStatus } from '~/api/environments';

export interface EnvStatusMeta {
  label: string;
  /** a tone setter, not a colour — the dot and the label both read it */
  tone: string;
  pulse: boolean;
}

const STATUS_META: Record<ProjectEnvironmentStatus, EnvStatusMeta> = {
  active: { label: 'Active', tone: 'of-tone-done', pulse: false },
  starting: { label: 'Starting', tone: 'of-tone-needs-you', pulse: true },
  publishing: { label: 'Publishing', tone: 'of-tone-needs-you', pulse: true },
  claiming: { label: 'Claiming', tone: 'of-tone-needs-you', pulse: true },
  pending: { label: 'Pending', tone: 'of-tone-needs-you', pulse: true },
  suspended: { label: 'Suspended', tone: 'of-tone-neutral', pulse: false },
  disabled: { label: 'Disabled', tone: 'of-tone-neutral', pulse: false },
  failed: { label: 'Failed', tone: 'of-tone-failed', pulse: false },
};

export function envStatusMeta(status: ProjectEnvironmentStatus): EnvStatusMeta {
  return STATUS_META[status];
}
