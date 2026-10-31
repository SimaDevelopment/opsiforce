import { createEffect, createSignal } from 'solid-js';
import type { SearchSchemaInput } from '@tanstack/solid-router';
import { debounce } from '@solid-primitives/scheduled';
import { STORE_FILTERS, type StoreFilter } from '~/api/store';
import { Ban, Lock, UserRound } from '~/components/icons';
import { KIND_ICONS, type FilterChipOption } from '~/components/store/store-list';

export const STORE_SORTS = ['name', 'newest'] as const;

export type StoreSort = (typeof STORE_SORTS)[number];

export const SORT_OPTIONS: { id: StoreSort; label: string }[] = [
  { id: 'name', label: 'Name' },
  { id: 'newest', label: 'Newest' },
];

export interface StoreListSearch {
  filter: StoreFilter;
  q: string;
  sort: StoreSort;
}

export interface StoreListProps {
  filter: StoreFilter;
  query: string;
  sort: StoreSort;
  onFilter: (filter: StoreFilter) => void;
  onQuery: (query: string) => void;
  onSort: (sort: StoreSort) => void;
}

export function validateSort(search: Record<string, unknown>): StoreSort {
  return STORE_SORTS.find((candidate) => candidate === search.sort) ?? 'name';
}

export function validateStoreSearch(search: Record<string, unknown> & SearchSchemaInput): StoreListSearch {
  const filter = STORE_FILTERS.find((candidate) => candidate === search.filter);
  return { filter: filter ?? 'all', q: typeof search.q === 'string' ? search.q : '', sort: validateSort(search) };
}

const byName = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

export function sortStoreRows<T>(
  rows: readonly T[],
  sort: StoreSort,
  keys: { label: (row: T) => string; createdAt: (row: T) => string | null }
): T[] {
  const alphabetical = (a: T, b: T) => byName.compare(keys.label(a), keys.label(b));
  if (sort === 'name') return rows.toSorted(alphabetical);
  return rows.toSorted((a, b) => {
    const left = keys.createdAt(a);
    const right = keys.createdAt(b);
    if (left === right) return alphabetical(a, b);
    if (left === null) return 1;
    if (right === null) return -1;
    return right.localeCompare(left);
  });
}

const FILTER_OPTIONS: (FilterChipOption<StoreFilter> & { managersOnly?: boolean })[] = [
  { id: 'all', label: 'All', icon: KIND_ICONS.all },
  { id: 'mine', label: 'Created by me', icon: UserRound, managersOnly: true },
  { id: 'built_in', label: 'Built-in', icon: KIND_ICONS.built_in },
  { id: 'custom', label: 'Custom', icon: KIND_ICONS.custom },
  { id: 'private', label: 'Private', icon: Lock },
  { id: 'disabled', label: 'Disabled', icon: Ban, managersOnly: true },
];

export function filterOptions(canManage: boolean): FilterChipOption<StoreFilter>[] {
  return FILTER_OPTIONS.filter((option) => canManage || !option.managersOnly);
}

const SEARCH_DEBOUNCE_MS = 250;

/** The typed text is local so keystrokes never wait on the router; the URL catches up after a pause. */
export function createSearchDraft(urlQuery: () => string, push: (query: string) => void) {
  const [draft, setDraft] = createSignal(urlQuery());
  let pushed = urlQuery();

  const pushDebounced = debounce((value: string) => {
    pushed = value;
    push(value);
  }, SEARCH_DEBOUNCE_MS);

  createEffect(() => {
    const fromUrl = urlQuery();
    if (fromUrl === pushed) return;
    pushed = fromUrl;
    setDraft(fromUrl);
  });

  return {
    draft,
    onInput: (value: string) => {
      setDraft(value);
      pushDebounced(value);
    },
  };
}
