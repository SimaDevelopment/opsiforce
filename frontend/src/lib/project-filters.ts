import type { Project, Workspace } from '~/api/client';
import { createPersistedStringSignal } from './persisted-signal';

/**
 * Narrowing the project list.
 *
 * The tree answers where a project sits, and it answers it completely: every
 * project is reachable there, including the ones with no workspace. So this
 * only asks what the structure cannot — Mine, which crosses workspaces, and
 * how recently something was touched, which the tree has no axis for.
 *
 * Private and Public deliberately are not scopes. A private workspace is a
 * workspace and already has its row; "public" is the absence of one and
 * already has its group. Repeating them here would restate the tree rather
 * than add to it.
 */

export const SCOPES = ['all', 'mine'] as const;
export const RECENCIES = ['any', '7d', '30d', 'older'] as const;

export type Scope = (typeof SCOPES)[number];
export type Recency = (typeof RECENCIES)[number];

export const SCOPE_LABEL: Record<Scope, string> = {
  all: 'All',
  mine: 'Mine',
};

export const RECENCY_LABEL: Record<Recency, string> = {
  any: 'Any time',
  '7d': 'Active last 7 days',
  '30d': 'Active last 30 days',
  older: 'Older',
};

export const SCOPE_KEY = 'opsiforce:projects:scope';
export const RECENCY_KEY = 'opsiforce:projects:recency';

const DAY = 24 * 60 * 60 * 1000;

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  return (Date.now() - then) / DAY;
}

/**
 * A project that has never run has no `lastActiveAt`, so its age is the day it
 * was made — one created an hour ago is not "older", it is simply empty. Only
 * when neither date exists does it fall to Older, where an unplaceable project
 * is at least not claiming to be recent.
 */
export function matchesRecency(project: Project, recency: Recency): boolean {
  if (recency === 'any') return true;
  const age = daysSince(project.lastActiveAt) ?? daysSince(project.createdAt);
  if (age === null) return recency === 'older';
  if (recency === '7d') return age <= 7;
  if (recency === '30d') return age <= 30;
  return age > 30;
}

/** Mine is the private workspace this user owns — the one view the tree cannot give. */
export function matchesScope(
  project: Project,
  scope: Scope,
  workspaces: Workspace[] | undefined,
  currentUserId: string | undefined
): boolean {
  if (scope === 'all') return true;
  const workspace = workspaces?.find((w) => w.id === project.workspaceId);
  if (!workspace) return false;
  return workspace.type === 'private' && !!currentUserId && workspace.ownerId === currentUserId;
}

export function filterProjects(
  projects: Project[] | undefined,
  scope: Scope,
  recency: Recency,
  workspaces: Workspace[] | undefined,
  currentUserId: string | undefined
): Project[] {
  return (projects ?? []).filter(
    (p) => matchesScope(p, scope, workspaces, currentUserId) && matchesRecency(p, recency)
  );
}

export const isScope = (v: string | null | undefined): v is Scope => !!v && (SCOPES as readonly string[]).includes(v);
export const isRecency = (v: string | null | undefined): v is Recency =>
  !!v && (RECENCIES as readonly string[]).includes(v);

export function createProjectFilters() {
  const [rawScope, setRawScope] = createPersistedStringSignal(SCOPE_KEY, 'all');
  const [rawRecency, setRawRecency] = createPersistedStringSignal(RECENCY_KEY, 'any');

  const scope = (): Scope => (isScope(rawScope()) ? (rawScope() as Scope) : 'all');
  const recency = (): Recency => (isRecency(rawRecency()) ? (rawRecency() as Recency) : 'any');
  const active = () => scope() !== 'all' || recency() !== 'any';

  return {
    scope,
    setScope: (v: Scope) => setRawScope(v),
    recency,
    setRecency: (v: Recency) => setRawRecency(v),
    active,
    reset: () => {
      setRawScope('all');
      setRawRecency('any');
    },
  };
}
