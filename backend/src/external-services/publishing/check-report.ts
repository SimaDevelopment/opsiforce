import type { ManifestCheck, ManifestProblem } from '@opsiforce/external-service-sdk';

export interface CheckedEvent {
  type: string;
  title: string;
}

export interface CheckReport {
  ok: boolean;
  problems: ManifestProblem[];
  events: CheckedEvent[];
}

export function checkReportOf(check: ManifestCheck): CheckReport {
  return {
    ok: check.ok,
    problems: check.problems,
    events: Object.entries(check.manifest?.events ?? {}).map(([type, event]) => ({ type, title: event.title })),
  };
}
