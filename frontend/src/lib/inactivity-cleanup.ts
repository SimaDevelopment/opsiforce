import type { InactivityCleanup, Project } from '~/api/client';
import type { Permission } from '~/constants/permissions';

import { TIME_UNITS } from '~/lib/duration-units';

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;
export const MIN_INACTIVITY_MS = HOUR_MS;
export const MAX_INACTIVITY_MS = 3650 * DAY_MS;
export const CLEANUP_UNITS = TIME_UNITS.filter((unit) => unit.value !== 'minutes');
const CLEANUP_SOON_MS = 7 * DAY_MS;

export type CleanupField = keyof InactivityCleanup;

export interface CleanupStep {
  action: 'disable' | 'delete';
  field: CleanupField;
  permission: Permission;
  label: string;
  title: string;
  description: string;
  warning: string | null;
  upcoming: string;
  soon: string;
  done: string;
  onlyEnabledProjects: boolean;
  destructive: boolean;
}

export const CLEANUP_STEPS: readonly CleanupStep[] = [
  {
    action: 'disable',
    field: 'disableAfter',
    permission: 'can_disable_project',
    label: 'Disable after',
    title: 'Disable when inactive',
    description: 'Stops the Project until someone enables it again. Its files, chats and App stay.',
    warning: null,
    upcoming: 'Disables',
    soon: 'Disabling soon',
    done: 'disabled',
    onlyEnabledProjects: true,
    destructive: false,
  },
  {
    action: 'delete',
    field: 'deleteAfter',
    permission: 'can_delete_project',
    label: 'Delete after',
    title: 'Delete when inactive',
    description: 'Removes the Project with its files, chats and App.',
    warning: 'This can’t be undone.',
    upcoming: 'Deletes',
    soon: 'Deleting soon',
    done: 'deleted',
    onlyEnabledProjects: false,
    destructive: true,
  },
];

export function perStep<T>(value: (step: CleanupStep) => T): Record<CleanupField, T> {
  return Object.fromEntries(CLEANUP_STEPS.map((step) => [step.field, value(step)])) as Record<CleanupField, T>;
}

export const NEVER_CLEANED_UP: InactivityCleanup = perStep(() => null);

export interface ScheduledCleanup {
  step: CleanupStep;
  at: Date;
}

const momentFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const relativeFormat = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

export function cleanupDate(lastActivityAt: string, after: number | null): Date | null {
  return after === null ? null : new Date(new Date(lastActivityAt).getTime() + after);
}

export function isDue(at: Date, now = Date.now()): boolean {
  return at.getTime() <= now;
}

export function isSoon(at: Date, now = Date.now()): boolean {
  return at.getTime() - now <= CLEANUP_SOON_MS;
}

export function formatMoment(at: Date): string {
  return momentFormat.format(at);
}

export function formatRelative(at: Date, now = Date.now()): string {
  const diff = at.getTime() - now;
  if (Math.abs(diff) < DAY_MS) return relativeFormat.format(Math.round(diff / HOUR_MS), 'hour');
  return relativeFormat.format(Math.round(diff / DAY_MS), 'day');
}

export function formatDuration(ms: number): string {
  const [amount, unit] = ms >= DAY_MS && ms % DAY_MS === 0 ? [ms / DAY_MS, 'day'] : [Math.round(ms / HOUR_MS), 'hour'];
  return `${amount} ${unit}${amount === 1 ? '' : 's'}`;
}

export function formatIdleFor(lastActivityAt: string, now = Date.now()): string {
  const idle = Math.max(0, now - new Date(lastActivityAt).getTime());
  if (idle < HOUR_MS) return 'less than an hour';
  return formatDuration(idle >= DAY_MS ? Math.floor(idle / DAY_MS) * DAY_MS : Math.floor(idle / HOUR_MS) * HOUR_MS);
}

export function capitalized(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

export function describeCleanup(cleanup: InactivityCleanup): string {
  const parts = CLEANUP_STEPS.flatMap((step) => {
    const after = cleanup[step.field];
    return after === null ? [] : [`${step.done} after ${formatDuration(after)}`];
  });
  return parts.length === 0 ? 'Never cleaned up' : `${capitalized(parts.join(', '))} without activity`;
}

export function scheduledCleanups(
  lastActivityAt: string,
  cleanup: InactivityCleanup,
  projectDisabled: boolean
): ScheduledCleanup[] {
  return CLEANUP_STEPS.flatMap((step) => {
    const at = step.onlyEnabledProjects && projectDisabled ? null : cleanupDate(lastActivityAt, cleanup[step.field]);
    return at ? [{ step, at }] : [];
  });
}

export function nextCleanup(project: Project): ScheduledCleanup | null {
  const scheduled = scheduledCleanups(project.lastActivityAt, project, project.status === 'disabled');
  return scheduled.findLast((cleanup) => isDue(cleanup.at)) ?? scheduled[0] ?? null;
}

export function newlyDueCleanup(
  lastActivityAt: string,
  saved: InactivityCleanup,
  draft: InactivityCleanup,
  projectDisabled: boolean
): ScheduledCleanup | null {
  const alreadyDue = new Set(
    scheduledCleanups(lastActivityAt, saved, projectDisabled)
      .filter((cleanup) => isDue(cleanup.at))
      .map((cleanup) => cleanup.step)
  );
  return (
    scheduledCleanups(lastActivityAt, draft, projectDisabled).findLast(
      (cleanup) => isDue(cleanup.at) && !alreadyDue.has(cleanup.step)
    ) ?? null
  );
}
