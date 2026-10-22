export type PatternSegment = { kind: 'literal'; text: string } | { kind: 'param'; name: string } | { kind: 'rest' };

export interface RoutePattern {
  source: string;
  methods: readonly string[] | '*';
  segments: readonly PatternSegment[];
}

export class RoutePatternError extends Error {
  constructor(pattern: string, problem: string) {
    super(`route '${pattern}': ${problem}`);
    this.name = 'RoutePatternError';
  }
}

const methodPattern = /^[A-Z][A-Z0-9-]*$/;
const paramPattern = /^:[A-Za-z_][A-Za-z0-9_]*$/;

export function parseRoutePattern(source: string): RoutePattern {
  const match = /^(\S+) (\/\S*)$/.exec(source);
  if (!match) throw new RoutePatternError(source, "write '<METHOD>[|<METHOD>…] <path>' or '* <path>'");
  const [, methodPart = '', path = ''] = match;
  const methods = methodPart === '*' ? '*' : methodPart.split('|');
  if (methods !== '*' && !methods.every((method) => methodPattern.test(method))) {
    throw new RoutePatternError(source, 'methods are upper case and separated by |');
  }

  const parts = path === '/' ? [] : path.slice(1).split('/');
  const segments = parts.map((part, index): PatternSegment => {
    if (part === '**') {
      if (index !== parts.length - 1) throw new RoutePatternError(source, '** may only be the last segment');
      return { kind: 'rest' };
    }
    if (part.startsWith(':')) {
      if (!paramPattern.test(part)) {
        throw new RoutePatternError(source, `${part} must be a whole segment named with letters, digits or _`);
      }
      return { kind: 'param', name: part.slice(1) };
    }
    if (part === '' || part.includes('*') || part.includes(':')) {
      throw new RoutePatternError(source, `'${part}' is not a literal segment`);
    }
    return { kind: 'literal', text: part };
  });
  const names = segments.flatMap((segment) => (segment.kind === 'param' ? [segment.name] : []));
  if (new Set(names).size !== names.length) throw new RoutePatternError(source, 'a parameter name is used twice');
  return { source, methods, segments };
}

export function decodedSegments(path: string): string[] | undefined {
  if (path === '/') return [];
  try {
    return path
      .slice(1)
      .split('/')
      .map((segment) => decodeURIComponent(segment));
  } catch {
    return undefined;
  }
}

export function matchRoutePattern(
  pattern: RoutePattern,
  method: string,
  segments: readonly string[]
): Record<string, string> | undefined {
  if (pattern.methods !== '*' && !pattern.methods.includes(method)) return undefined;
  const params: Record<string, string> = {};
  for (const [index, expected] of pattern.segments.entries()) {
    if (expected.kind === 'rest') return params;
    const actual = segments[index];
    if (actual === undefined) return undefined;
    if (expected.kind === 'literal' && actual !== expected.text) return undefined;
    if (expected.kind === 'param') {
      if (actual === '') return undefined;
      params[expected.name] = actual;
    }
  }
  return segments.length === pattern.segments.length ? params : undefined;
}

const encodedSeparator = /%2f|%5c/i;

export function isSafePath(path: string): boolean {
  if (!path.startsWith('/') || path.includes('//') || path.includes('\\') || encodedSeparator.test(path)) {
    return false;
  }
  return path
    .slice(1)
    .split('/')
    .every((segment) => {
      const dots = segment.replace(/%2e/gi, '.');
      return dots !== '.' && dots !== '..';
    });
}
