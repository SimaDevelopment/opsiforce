import { createEffect, createSignal } from 'solid-js';
import type { SearchSchemaInput } from '@tanstack/solid-router';
import { debounce } from '@solid-primitives/scheduled';
import { STORE_FILTERS, type StoreFilter } from '~/api/store';

export interface StoreListSearch {
  filter: StoreFilter;
  q: string;
}

export interface StoreListProps {
  filter: StoreFilter;
  query: string;
  onFilter: (filter: StoreFilter) => void;
  onQuery: (query: string) => void;
}

export function validateStoreSearch(search: Record<string, unknown> & SearchSchemaInput): StoreListSearch {
  const filter = STORE_FILTERS.find((candidate) => candidate === search.filter);
  return { filter: filter ?? 'all', q: typeof search.q === 'string' ? search.q : '' };
}

const FILTER_OPTIONS: { id: StoreFilter; label: string; managersOnly?: boolean }[] = [
  { id: 'all', label: 'All' },
  { id: 'mine', label: 'Created by me', managersOnly: true },
  { id: 'built_in', label: 'Built-in' },
  { id: 'custom', label: 'Custom' },
  { id: 'private', label: 'Private' },
  { id: 'disabled', label: 'Disabled', managersOnly: true },
];

export function filterOptions(canManage: boolean): { id: StoreFilter; label: string }[] {
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
