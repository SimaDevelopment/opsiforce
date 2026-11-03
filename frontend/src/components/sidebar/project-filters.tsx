import { For, Show } from 'solid-js';
import { Popover, PopoverContent, PopoverTrigger } from '~/components/ui/popover';
import { ListFilter, X } from '~/components/icons';
import {
  RECENCIES,
  RECENCY_LABEL,
  SCOPES,
  SCOPE_LABEL,
  STATUS_FILTERS,
  STATUS_FILTER_LABEL,
  type Recency,
  type Scope,
  type StatusFilter,
} from '~/lib/project-filters';

/**
 * Narrowing lives beside the text search, because they are the same act: the
 * field narrows by name, this narrows by scope, status and recency. Keeping it in a
 * popover costs the tree no height — the sidebar's vertical space belongs to
 * the projects, not to the controls that hide them.
 *
 * A filter that is on says so from the outside: the trigger carries a dot and
 * the chips sit under the row, because a list quietly dropping projects is
 * worse than no filter at all.
 */
export function ProjectFilters(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope: Scope;
  onScopeChange: (scope: Scope) => void;
  recency: Recency;
  onRecencyChange: (recency: Recency) => void;
  status: StatusFilter;
  onStatusChange: (status: StatusFilter) => void;
  active: boolean;
  onReset: () => void;
  matchCount: number;
  totalCount: number;
}) {
  return (
    <Popover open={props.open} onOpenChange={props.onOpenChange} placement="bottom-end">
      <PopoverTrigger
        class="of-btn of-btn-icon of-btn-outline fr-panel relative shrink-0"
        aria-label={props.active ? 'Filters, active' : 'Filter projects'}
        title="Filter projects"
      >
        <ListFilter class="w-4 h-4" />
        <Show when={props.active}>
          <span class="of-filter-dot" aria-hidden="true" />
        </Show>
      </PopoverTrigger>
      <PopoverContent class="w-64 p-3">
        <div class="flex flex-col gap-3">
          <div class="flex items-baseline gap-2">
            <span class="t-label t-sub flex-1">Scope</span>
            <Show when={props.active}>
              <span class="t-meta t-sub">
                {props.matchCount} of {props.totalCount}
              </span>
            </Show>
          </div>
          <div class="flex flex-wrap gap-1">
            <For each={SCOPES}>
              {(value) => (
                <button
                  type="button"
                  class="of-chip of-chip-btn fr"
                  aria-pressed={props.scope === value}
                  data-on={props.scope === value}
                  onClick={() => props.onScopeChange(value)}
                >
                  {SCOPE_LABEL[value]}
                </button>
              )}
            </For>
          </div>

          <span class="t-label t-sub">Status</span>
          <div class="flex flex-wrap gap-1">
            <For each={STATUS_FILTERS}>
              {(value) => (
                <button
                  type="button"
                  class="of-chip of-chip-btn fr"
                  aria-pressed={props.status === value}
                  data-on={props.status === value}
                  onClick={() => props.onStatusChange(value)}
                >
                  {STATUS_FILTER_LABEL[value]}
                </button>
              )}
            </For>
          </div>

          <span class="t-label t-sub">Activity</span>
          <div class="flex flex-col gap-1">
            <For each={RECENCIES}>
              {(value) => (
                <button
                  type="button"
                  class="of-chip of-chip-btn fr justify-start"
                  aria-pressed={props.recency === value}
                  data-on={props.recency === value}
                  onClick={() => props.onRecencyChange(value)}
                >
                  {RECENCY_LABEL[value]}
                </button>
              )}
            </For>
          </div>

          <Show when={props.active}>
            <button type="button" class="of-btn of-btn-compact of-btn-ghost fr self-start" onClick={props.onReset}>
              <X class="w-3 h-3" />
              Clear filters
            </button>
          </Show>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** The chips under the search row, so an active filter is visible unopened. */
export function ProjectFilterChips(props: {
  scope: Scope;
  recency: Recency;
  status: StatusFilter;
  active: boolean;
  onReset: () => void;
}) {
  return (
    <Show when={props.active}>
      <div class="flex items-center gap-1.5 flex-wrap px-2 pb-1">
        <Show when={props.scope !== 'all'}>
          <span class="of-chip">{SCOPE_LABEL[props.scope]}</span>
        </Show>
        <Show when={props.recency !== 'any'}>
          <span class="of-chip">{RECENCY_LABEL[props.recency]}</span>
        </Show>
        <Show when={props.status !== 'all'}>
          <span class="of-chip">{STATUS_FILTER_LABEL[props.status]}</span>
        </Show>
        <button type="button" class="of-btn of-btn-compact of-btn-ghost fr-panel" onClick={props.onReset}>
          <X class="w-3 h-3" />
          Clear
        </button>
      </div>
    </Show>
  );
}
