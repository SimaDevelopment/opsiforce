import type { ManifestCheck } from './check-manifest.ts';
import { manifestFileName } from './service-folder.ts';

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export function formatCheck(result: ManifestCheck): string {
  const lines = result.problems.map(
    (problem) =>
      `${problem.severity.padEnd(7)} ${problem.path === '' ? manifestFileName : problem.path}: ${problem.message}`
  );
  const errors = result.problems.filter((problem) => problem.severity === 'error').length;
  const warnings = result.problems.length - errors;
  lines.push(`${manifestFileName}: ${plural(errors, 'error')}, ${plural(warnings, 'warning')}`);
  return lines.join('\n') + '\n';
}
