import type { Paramtype } from '@nestjs/common';
import type { ValidationErrorItem } from '../errors/error.schema';

type PathSegment = PropertyKey | { key: PropertyKey };

interface Issue {
  readonly message: string;
  readonly path?: ReadonlyArray<PathSegment>;
}

interface UnrecognizedKeysIssue extends Issue {
  readonly code: 'unrecognized_keys';
  readonly keys: readonly string[];
}

const LOCATION_BY_PARAMTYPE: Partial<Record<Paramtype, ValidationErrorItem['in']>> = {
  body: 'body',
  query: 'query',
  param: 'path',
};

function segmentsOf(path: Issue['path']): string[] {
  if (!path) return [];
  return path.map((segment) =>
    typeof segment === 'object' && segment !== null ? String(segment.key) : String(segment)
  );
}

function pointerOf(segments: string[]): string {
  return segments.length === 0 ? '#' : `#/${segments.join('/')}`;
}

function isUnrecognizedKeys(issue: Issue): issue is UnrecognizedKeysIssue {
  return 'code' in issue && issue.code === 'unrecognized_keys' && Array.isArray((issue as UnrecognizedKeysIssue).keys);
}

export class ValidationIssuesSignal extends Error {
  constructor(
    readonly issues: readonly Issue[],
    readonly paramtype: Paramtype
  ) {
    super('validation issues');
  }

  toErrorItems(): ValidationErrorItem[] {
    const location = LOCATION_BY_PARAMTYPE[this.paramtype] ?? 'body';
    return this.issues.flatMap((issue) => {
      const segments = segmentsOf(issue.path);
      if (!isUnrecognizedKeys(issue)) {
        return [{ detail: issue.message, pointer: pointerOf(segments), in: location }];
      }
      return issue.keys.map((key) => ({
        detail: `Unrecognized key: "${key}"`,
        pointer: pointerOf([...segments, key]),
        in: location,
      }));
    });
  }
}
