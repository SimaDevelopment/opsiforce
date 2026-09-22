import { createSignal, onCleanup, type Accessor } from 'solid-js';

/**
 * Centralized localStorage-backed signal.
 *
 * Use this for any UI state that needs to survive reloads (sidebar fold state,
 * user picks, etc.) instead of hand-rolling `localStorage.getItem/setItem`
 * calls. This hook handles JSON (de)serialization, cross-tab sync via `storage`
 * events, and same-tab sync via dispatched synthetic events.
 *
 * ## Key naming convention
 *
 * New keys MUST be prefixed `opsiforce:<domain>[:sub-domain]` — e.g.
 * `opsiforce:workspace:folded`, `opsiforce:settings:last-tab`.
 *
 * Two legacy keys are grandfathered (unprefixed) and should stay that way to
 * avoid logging users out or resetting their sidebars on deploy:
 *  - `tenant` (current tenant selection)
 *  - `sidebar:state` (sidebar collapsed/expanded)
 *
 * ## Why not @solid-primitives/storage?
 *
 * We already ship that as a transitive dep but have a repo-wide preference to
 * keep our persistence layer small and explicit. If needs grow (e.g. SSR,
 * IndexedDB backend) we can swap this internally without touching call sites.
 */
export interface PersistedSignalOptions<T> {
  /** Custom serializer. Defaults to `JSON.stringify`. */
  serialize?: (value: T) => string;
  /** Custom deserializer. Defaults to `JSON.parse`. Thrown errors fall back to `defaultValue`. */
  deserialize?: (raw: string) => T;
  /** Cross-tab sync via the `storage` event. Defaults to `true`. */
  sync?: boolean;
}

export type PersistedSignal<T> = [Accessor<T>, (value: T | ((prev: T) => T)) => void];

export function createPersistedSignal<T>(
  key: string,
  defaultValue: T,
  options: PersistedSignalOptions<T> = {}
): PersistedSignal<T> {
  const serialize = options.serialize ?? JSON.stringify;
  const deserialize = options.deserialize ?? (JSON.parse as (raw: string) => T);
  const sync = options.sync ?? true;

  const read = (): T => {
    if (typeof window === 'undefined') return defaultValue;
    const raw = window.localStorage.getItem(key);
    if (raw === null) return defaultValue;
    try {
      return deserialize(raw);
    } catch {
      return defaultValue;
    }
  };

  const [value, setValue] = createSignal<T>(read());

  const write = (next: T) => {
    if (typeof window === 'undefined') return;
    try {
      const serialized = serialize(next);
      window.localStorage.setItem(key, serialized);
      if (sync) {
        // Dispatch a synthetic storage event so other hooks listening in this
        // same tab update too. StorageEvent in most browsers doesn't fire in
        // the origin tab, only in other tabs.
        window.dispatchEvent(new StorageEvent('storage', { key, newValue: serialized }));
      }
    } catch {
      // Ignore quota / serialization errors — persistence is best-effort.
    }
  };

  const update = (next: T | ((prev: T) => T)) => {
    const resolved = typeof next === 'function' ? (next as (prev: T) => T)(value()) : next;
    setValue(() => resolved);
    write(resolved);
  };

  if (sync && typeof window !== 'undefined') {
    const handler = (e: StorageEvent) => {
      if (e.key !== key) return;
      const raw = e.newValue;
      if (raw === null) {
        setValue(() => defaultValue);
        return;
      }
      try {
        setValue(() => deserialize(raw));
      } catch {
        // ignore — keep current value
      }
    };
    window.addEventListener('storage', handler);
    onCleanup(() => window.removeEventListener('storage', handler));
  }

  return [value, update];
}

/**
 * Raw string variant — skips JSON. Useful for existing unprefixed keys that
 * store plain strings (`sidebar:state` = `"true"`).
 */
export function createPersistedStringSignal(key: string, defaultValue: string, sync = true): PersistedSignal<string> {
  return createPersistedSignal<string>(key, defaultValue, {
    serialize: (v) => v,
    deserialize: (raw) => raw,
    sync,
  });
}
