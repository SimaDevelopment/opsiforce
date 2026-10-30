import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount, type Component } from 'solid-js';
import { useNavigate } from '@tanstack/solid-router';
import fuzzysort from 'fuzzysort';
import { useProjects } from '~/api/projects';
import { usePermissions } from '~/api/permissions';
import { firstPermittedSettingsTab } from '~/constants/settings-tabs';
import { firstPermittedAdminTab } from '~/constants/admin-tabs';
import { useAppearance } from '~/lib/appearance';
import { projectDisplayTitle } from '~/lib/project-display';
import { Calendar, FolderKanban, House, Moon, Search, Server, Settings, Store, Sun } from '~/components/icons';

/**
 * Go to — one list of projects, destinations and actions behind
 * Cmd/Ctrl K. Module-level state so the band button and the shortcut drive
 * the same dialog without a provider.
 */
const [open, setOpen] = createSignal(false);

const isApple = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const SHORTCUT_KEYS = isApple ? ['⌘', 'K'] : ['Ctrl', 'K'];
export const PALETTE_SHORTCUT = isApple ? '⌘K' : 'Ctrl+K';

function PaletteShortcut(props: { class?: string }) {
  return (
    <span class={`inline-flex items-center gap-0.5 ${props.class ?? ''}`}>
      <For each={SHORTCUT_KEYS}>{(key) => <kbd class="of-kbd">{key}</kbd>}</For>
    </span>
  );
}

export const commandPaletteOpen = open;
export const openCommandPalette = () => setOpen(true);
export const closeCommandPalette = () => setOpen(false);
export const toggleCommandPalette = () => setOpen((v) => !v);

interface Item {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon: Component<{ class?: string; size?: number }>;
  run: () => void;
}

export function CommandPalette() {
  const navigate = useNavigate();
  const projects = useProjects();
  const { hasPermission } = usePermissions();
  const appearance = useAppearance();

  const [query, setQuery] = createSignal('');
  const [cursor, setCursor] = createSignal(0);
  let inputRef: HTMLInputElement | undefined;
  let listRef: HTMLDivElement | undefined;

  const go = (run: () => void) => {
    setOpen(false);
    run();
  };

  const items = createMemo<Item[]>(() => {
    const out: Item[] = [];

    for (const project of projects.data ?? []) {
      out.push({
        id: `project:${project.id}`,
        group: 'Projects',
        label: projectDisplayTitle(project),
        icon: FolderKanban,
        run: () =>
          navigate({
            to: '/projects/$projectId',
            params: { projectId: project.id },
            search: { prompt: undefined, promptId: undefined },
          }),
      });
    }

    out.push({ id: 'go:home', group: 'Go to', label: 'Home', icon: House, run: () => navigate({ to: '/' }) });
    if (hasPermission('can_manage_schedules')) {
      out.push({
        id: 'go:schedules',
        group: 'Go to',
        label: 'Schedules',
        icon: Calendar,
        run: () => navigate({ to: '/schedules' }),
      });
    }
    out.push({
      id: 'go:store',
      group: 'Go to',
      label: 'Skill & Agent Store',
      icon: Store,
      run: () => navigate({ to: '/store' }),
    });
    if (firstPermittedSettingsTab(hasPermission)) {
      out.push({
        id: 'go:settings',
        group: 'Go to',
        label: 'Settings',
        icon: Settings,
        run: () => navigate({ to: '/settings' }),
      });
    }
    if (firstPermittedAdminTab(hasPermission)) {
      out.push({ id: 'go:admin', group: 'Go to', label: 'Admin', icon: Server, run: () => navigate({ to: '/admin' }) });
    }

    const dark = appearance.scheme() === 'dark';
    out.push({
      id: 'act:theme',
      group: 'Appearance',
      label: dark ? 'Switch to light mode' : 'Switch to dark mode',
      hint: appearance.mode() === 'system' ? 'Currently following the system' : undefined,
      icon: dark ? Sun : Moon,
      run: () => appearance.setMode(dark ? 'light' : 'dark'),
    });

    return out;
  });

  const filtered = createMemo<Item[]>(() => {
    const q = query().trim();
    if (!q) return items();
    const results = fuzzysort.go(q, items(), { key: 'label', limit: 40 });
    return results.map((r) => r.obj);
  });

  // Grouped for display, but the cursor walks the flat list so the arrow keys
  // cross group boundaries the way every other palette does.
  const groups = createMemo(() => {
    const order: { name: string; items: Item[] }[] = [];
    const byGroup = new Map<string, Item[]>();
    for (const item of filtered()) {
      let bucket = byGroup.get(item.group);
      if (!bucket) {
        bucket = [];
        byGroup.set(item.group, bucket);
        order.push({ name: item.group, items: bucket });
      }
      bucket.push(item);
    }
    return order;
  });

  // the rows are rendered by group, so the cursor walks the grouped order,
  // not the ranked one
  const ordered = createMemo<Item[]>(() => groups().flatMap((group) => group.items));

  const flatIndex = (item: Item) => ordered().indexOf(item);

  // The palette is hidden rather than unmounted, so the list keeps its scroll
  // position between openings; the cursor and the scroll reset together, or
  // the selected row would sit above the fold.
  const resetCursor = () => {
    setCursor(0);
    if (listRef) listRef.scrollTop = 0;
  };

  createEffect(() => {
    query();
    resetCursor();
  });

  // A hidden element cannot take focus, and the dialog is `visibility: hidden`
  // until the open attribute lands and style is recalculated. One frame is not
  // reliably enough, so keep trying for a few frames and then give up rather
  // than leaving focus on <body> with a search field on screen.
  const focusInput = (framesLeft = 6) => {
    const el = inputRef;
    if (!el) return;
    el.focus();
    if (document.activeElement === el || framesLeft === 0) return;
    requestAnimationFrame(() => focusInput(framesLeft - 1));
  };

  let lastFocused: HTMLElement | null = null;

  createEffect(() => {
    if (!open()) {
      // give focus back to whatever opened the palette
      lastFocused?.focus?.();
      lastFocused = null;
      return;
    }
    lastFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuery('');
    resetCursor();
    requestAnimationFrame(() => focusInput());
  });

  const move = (delta: number) => {
    const total = ordered().length;
    if (total === 0) return;
    const next = (cursor() + delta + total) % total;
    setCursor(next);
    listRef?.querySelector<HTMLElement>(`[data-index="${next}"]`)?.scrollIntoView({ block: 'nearest' });
  };

  const onGlobalKeyDown = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      toggleCommandPalette();
      return;
    }
    if (e.key === 'Escape' && open()) {
      e.preventDefault();
      setOpen(false);
    }
  };

  onMount(() => {
    window.addEventListener('keydown', onGlobalKeyDown);
    onCleanup(() => window.removeEventListener('keydown', onGlobalKeyDown));
  });

  const onInputKeyDown = (e: KeyboardEvent) => {
    // aria-modal does not contain focus by itself. The input is the only
    // tab stop in the palette (the rows are reached with the arrow keys, as in
    // any combobox) and the page behind is inert while it is open, so Tab in
    // either direction simply stays put.
    if (e.key === 'Tab') {
      e.preventDefault();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = ordered()[cursor()];
      if (item) go(item.run);
    }
  };

  return (
    <>
      {/* a control, not a decorated div: clicking it closes, and it stays out
          of the Tab order so the input keeps focus */}
      <button
        type="button"
        class="of-scrim"
        data-open={open()}
        tabindex={-1}
        aria-hidden={open() ? undefined : true}
        aria-label="Close"
        onClick={() => setOpen(false)}
      />
      <div class="of-cmdk" data-open={open()} role="dialog" aria-modal="true" aria-label="Go to">
        <div class="of-cmdk-top">
          <Search class="w-4 h-4 shrink-0" style={{ color: 'var(--ink-subtle)' }} />
          <input
            ref={(el) => (inputRef = el)}
            type="text"
            placeholder="Go to a project, page or action…"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={onInputKeyDown}
            aria-label="Go to a project, page or action"
            aria-autocomplete="list"
            aria-controls="of-cmdk-list"
            aria-activedescendant={ordered()[cursor()] ? `of-cmdk-opt-${cursor()}` : undefined}
            autocomplete="off"
            spellcheck={false}
          />
          <kbd class="of-kbd">esc</kbd>
        </div>

        <div class="of-cmdk-list" id="of-cmdk-list" role="listbox" aria-label="Results" ref={(el) => (listRef = el)}>
          <Show
            when={filtered().length > 0}
            fallback={
              <p class="t-meta" style={{ padding: '18px 10px', color: 'var(--ink-subtle)' }}>
                Nothing matches “{query()}”.
              </p>
            }
          >
            <For each={groups()}>
              {(group) => (
                <>
                  <div class="of-cmdk-grp t-label">{group.name}</div>
                  <For each={group.items}>
                    {(item) => {
                      const index = () => flatIndex(item);
                      return (
                        <button
                          type="button"
                          class="of-cmdk-row"
                          id={`of-cmdk-opt-${index()}`}
                          data-index={index()}
                          data-cursor={index() === cursor()}
                          role="option"
                          tabindex={-1}
                          aria-selected={index() === cursor()}
                          onMouseEnter={() => setCursor(index())}
                          onClick={() => go(item.run)}
                        >
                          <item.icon class="w-4 h-4 shrink-0" />
                          <span class="lbl">{item.label}</span>
                          <Show when={item.hint}>
                            <span class="t-meta t-sub">{item.hint}</span>
                          </Show>
                        </button>
                      );
                    }}
                  </For>
                </>
              )}
            </For>
          </Show>
        </div>

        <div class="of-cmdk-foot">
          <span class="inline-flex items-center gap-1.5">
            <kbd class="of-kbd">↑</kbd>
            <kbd class="of-kbd">↓</kbd>
            to move
          </span>
          <span class="inline-flex items-center gap-1.5">
            <kbd class="of-kbd">↵</kbd>
            to open
          </span>
          <PaletteShortcut class="ml-auto" />
        </div>
      </div>
    </>
  );
}
