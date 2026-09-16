import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';

type ForwardRefEntry = { forwardRef: () => unknown };
type DynamicModuleEntry = { module: unknown };

function isForwardRef(entry: unknown): entry is ForwardRefEntry {
  return typeof entry === 'object' && entry !== null && typeof (entry as ForwardRefEntry).forwardRef === 'function';
}

function isDynamicModule(entry: unknown): entry is DynamicModuleEntry {
  return typeof entry === 'object' && entry !== null && 'module' in entry;
}

function resolveEntry(entry: unknown): unknown {
  if (isForwardRef(entry)) return entry.forwardRef();
  if (isDynamicModule(entry)) return entry.module;
  return entry;
}

function nameOf(target: unknown): string {
  return typeof target === 'function' ? target.name : String(target);
}

function collectUnresolvedImports(root: unknown): string[] {
  const seen = new Set<unknown>();
  const queue: unknown[] = [root];
  const unresolved: string[] = [];

  while (queue.length > 0) {
    const target = queue.shift();
    if (typeof target !== 'function' || seen.has(target)) continue;
    seen.add(target);

    const imports = (Reflect.getMetadata('imports', target) ?? []) as unknown[];
    for (const [index, entry] of imports.entries()) {
      const resolved = resolveEntry(entry);
      if (resolved === undefined) {
        unresolved.push(`${nameOf(target)} imports[${index}]`);
        continue;
      }
      queue.push(resolved);
    }
  }

  return unresolved;
}

describe('the application module graph', () => {
  it('resolves every import reachable from AppModule despite the circular references', () => {
    expect(collectUnresolvedImports(AppModule)).toEqual([]);
  });
});
