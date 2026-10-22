import type { ServiceManifest } from '@opsiforce/external-service-sdk';

export type ManifestChange = 'added' | 'changed' | 'removed' | 'unchanged';

export type ChangedAspect = 'title' | 'description';

export interface EventChange {
  type: string;
  change: ManifestChange;
  aspects: ChangedAspect[];
}

export interface ManifestDiff {
  events: EventChange[];
}

interface ComparedEvent {
  title: string;
  description: string;
}

function aspectsBetween(before: ComparedEvent, after: ComparedEvent): ChangedAspect[] {
  const checks: [ChangedAspect, boolean][] = [
    ['title', before.title !== after.title],
    ['description', before.description !== after.description],
  ];
  return checks.filter(([, changed]) => changed).map(([aspect]) => aspect);
}

export function manifestDiff(base: ServiceManifest | null, next: ServiceManifest): ManifestDiff {
  const before: Record<string, ComparedEvent> = base?.events ?? {};
  const after: Record<string, ComparedEvent> = next.events ?? {};
  const present = Object.entries(after).map(([type, event]): EventChange => {
    const previous = before[type];
    if (!base || previous === undefined) return { type, change: 'added', aspects: [] };
    const aspects = aspectsBetween(previous, event);
    return { type, change: aspects.length > 0 ? 'changed' : 'unchanged', aspects };
  });
  const removed = Object.keys(before)
    .filter((type) => after[type] === undefined)
    .map((type): EventChange => ({ type, change: 'removed', aspects: [] }));
  return { events: [...present, ...removed] };
}
