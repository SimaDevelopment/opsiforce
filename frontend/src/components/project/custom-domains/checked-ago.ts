import { formatAgo } from '~/lib/format-duration';
import { elapsedSince } from '~/lib/use-now';

export function checkedAgo(checkedAt: string | null, now: number): string | null {
  return checkedAt === null ? null : formatAgo(elapsedSince(now, Date.parse(checkedAt)));
}

export function lastCheckedLine(checkedAt: string | null, now: number): string {
  const ago = checkedAgo(checkedAt, now);
  return ago === null ? 'Not checked yet.' : `Last checked ${ago}.`;
}
