import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';

type Ctor = new (...args: never[]) => unknown;

function metadata(target: unknown, key: string): unknown[] {
  return (Reflect.getMetadata(key, target as object) ?? []) as unknown[];
}

function resolve(entry: unknown): unknown {
  if (typeof entry === 'object' && entry !== null && 'forwardRef' in entry) {
    return (entry as { forwardRef: () => unknown }).forwardRef();
  }
  if (typeof entry === 'object' && entry !== null && 'module' in entry) {
    return (entry as { module: unknown }).module;
  }
  return entry;
}

const MODULE_KEYS = ['imports', 'providers', 'exports', 'controllers'];

function isModule(target: unknown): boolean {
  return typeof target === 'function' && MODULE_KEYS.some((key) => Reflect.hasMetadata(key, target));
}

/** Nest resolves these itself, so no module has to export them. */
const AMBIENT = new Set<unknown>([Reflector, Object, Function, String, Number, Boolean, Array]);

function providers(module: unknown): unknown[] {
  return metadata(module, 'providers').map((entry) =>
    typeof entry === 'object' && entry !== null && 'provide' in entry ? (entry as { provide: unknown }).provide : entry
  );
}

function exportsProvider(module: unknown, provider: unknown, seen = new Set<unknown>()): boolean {
  if (seen.has(module)) return false;
  seen.add(module);

  const exported = metadata(module, 'exports').map(resolve);
  if (exported.includes(provider) && providers(module).includes(provider)) return true;
  return exported.filter(isModule).some((exportedModule) => exportsProvider(exportedModule, provider, seen));
}

function isGlobal(module: unknown): boolean {
  return Reflect.getMetadata('__module:global__', module as object) === true;
}

function visibleIn(module: unknown, provider: unknown): boolean {
  if (providers(module).includes(provider)) return true;
  if (globalModules().some((global) => exportsProvider(global, provider))) return true;
  return metadata(module, 'imports')
    .map(resolve)
    .some((imported) => exportsProvider(imported, provider));
}

function enhancersOf(controller: unknown): Ctor[] {
  return [...metadata(controller, '__guards__'), ...metadata(controller, '__interceptors__')].filter(
    (entry): entry is Ctor => typeof entry === 'function' && Reflect.hasMetadata('design:paramtypes', entry)
  );
}

function reachableModules(root: unknown): unknown[] {
  const seen = new Set<unknown>();
  const queue = [root];
  while (queue.length > 0) {
    const module = queue.shift();
    if (typeof module !== 'function' || seen.has(module)) continue;
    seen.add(module);
    queue.push(...metadata(module, 'imports').map(resolve));
  }
  return [...seen];
}

let globals: unknown[] | null = null;

function globalModules(): unknown[] {
  globals ??= reachableModules(AppModule).filter(isGlobal);
  return globals;
}

function unresolvableEnhancerDependencies(): string[] {
  const missing: string[] = [];
  for (const module of reachableModules(AppModule)) {
    for (const controller of metadata(module, 'controllers')) {
      for (const enhancer of enhancersOf(controller)) {
        const dependencies = (Reflect.getMetadata('design:paramtypes', enhancer) ?? []) as Ctor[];
        for (const dependency of dependencies) {
          if (AMBIENT.has(dependency) || visibleIn(module, dependency)) continue;
          missing.push(
            `${(module as Ctor).name} hosts ${(controller as Ctor).name}, whose ${enhancer.name} needs ${dependency?.name ?? String(dependency)}`
          );
        }
      }
    }
  }
  return missing;
}

describe('controller-level guards and interceptors', () => {
  it('can be constructed in every module that hosts a controller using them', () => {
    expect(unresolvableEnhancerDependencies()).toEqual([]);
  });
});
