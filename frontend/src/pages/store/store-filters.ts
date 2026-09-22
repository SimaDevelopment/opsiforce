import { createEffect, createSignal } from 'solid-js';
import type { SearchSchemaInput } from '@tanstack/solid-router';
import { debounce } from '@solid-primitives/scheduled';
import { STORE_FILTERS, type StoreFilter } from '~/api/store';
import { BUILDER_CHAT_FILTERS, type BuilderChatFilter } from '~/api/builder';

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

export const BASE_FILTER_OPTIONS: { id: StoreFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'built_in', label: 'Built-in' },
  { id: 'custom', label: 'Custom' },
  { id: 'private', label: 'Private' },
];

export function filterOptions(canSeeArchived: boolean): { id: StoreFilter; label: string }[] {
  return canSeeArchived ? [...BASE_FILTER_OPTIONS, { id: 'archived', label: 'Archived' }] : BASE_FILTER_OPTIONS;
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

export interface BuilderListSearch {
  filter: BuilderChatFilter;
}

export function validateBuilderSearch(search: Record<string, unknown>): BuilderListSearch {
  const filter = BUILDER_CHAT_FILTERS.find((candidate) => candidate === search.filter);
  return { filter: filter ?? 'active' };
}

export const BUILDER_FILTER_OPTIONS: { id: BuilderChatFilter; label: string }[] = [
  { id: 'active', label: 'Active' },
  { id: 'mine', label: 'Started by me' },
  { id: 'archived', label: 'Archived' },
];
