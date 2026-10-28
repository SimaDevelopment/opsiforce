import { createEffect, onCleanup, onMount, untrack } from 'solid-js';
import { timelinePresets, type TimelineDetail } from '@opencode/session-ui/timeline/detail';
import { useTheme } from '@opencode/ui/theme/context';
import { useSettings } from '@opencode/app/settings/model';
import { useGlobal } from '@opencode/app/runtime/server/runtime';
import type { ServerConnection } from '@opencode/app';
import { BASE_FORMAT_IDS } from '~/api/model-providers';

const detailedPreset = timelinePresets.find((preset) => preset.id === 'detailed');
if (!detailedPreset) throw new Error('opencode timeline presets no longer include "detailed"');
const activityTimeline: TimelineDetail = {
  ...detailedPreset.value,
  shell: { placement: 'separate', details: 'collapsed' },
  edit: { placement: 'separate', details: 'collapsed' },
  thinking: { placement: 'separate', details: 'expanded' },
};
import { createAppearance } from '~/lib/appearance';
import { SHELL_CHAT_THEME, SHELL_CHAT_THEME_ID } from './opencode-shell-theme';

// The Builder page mounts two chats at once (its own and the Test Project's),
// and opencode's theme stylesheet is one document-wide element shared by both.
let mountedChats = 0;

type ModelKey = { providerID: string; modelID: string };
type Visibility = 'show' | 'hide';

type ReachableModels = ReadonlySet<string> | undefined;

const ROUTED_PROVIDERS: ReadonlySet<string> = new Set(BASE_FORMAT_IDS);

const visibilityKey = (model: ModelKey) => `${model.providerID}:${model.modelID}`;

const desiredVisibility = (model: ModelKey, reachable: ReachableModels): Visibility =>
  reachable && ROUTED_PROVIDERS.has(model.providerID) && !reachable.has(`${model.providerID}/${model.modelID}`)
    ? 'hide'
    : 'show';

const pinnedEntry = (model: ModelKey, reachable: ReachableModels) => ({
  ...model,
  visibility: desiredVisibility(model, reachable),
});

function pinModelVisibilityToCatalog(server: ServerConnection.Any, reachableModels: () => ReachableModels) {
  const global = useGlobal();
  const ctx = global.ensureServerCtx(server);

  createEffect(() => {
    const location = ctx.data.location.default();
    const served = location ? ctx.data.location.model.list(location) : undefined;
    if (!served) return;
    const reachable = reachableModels();
    const current = new Map(global.models.store.user.map((entry) => [visibilityKey(entry), entry.visibility]));
    const changes = served
      .filter((model) => model.status !== 'deprecated')
      .map((model) => pinnedEntry({ providerID: model.providerID, modelID: model.id }, reachable))
      .filter((model) => current.get(visibilityKey(model)) !== model.visibility);
    if (changes.length === 0) return;
    const changed = new Set(changes.map(visibilityKey));
    global.models.set('user', (user) => [...user.filter((entry) => !changed.has(visibilityKey(entry))), ...changes]);
  });
}

export function OpencodeOverrides(props: { server: ServerConnection.Any; reachableModels: () => ReachableModels }) {
  const theme = useTheme();
  const settings = useSettings();

  const appearance = createAppearance();

  onMount(() => {
    // The chat renders from opencode's own theme system; registering the
    // shell's palette here is what keeps the two surfaces one product, and it
    // keeps the palette on the consuming side instead of in the vendored tree.
    theme.registerTheme(SHELL_CHAT_THEME);
    theme.setTheme(SHELL_CHAT_THEME_ID);
    settings.appearance.setTabLayout('horizontal');
    settings.general.setShowFileTree(false);
    settings.general.setShowCustomAgents(true);
    settings.general.setTimelineDetail(activityTimeline);
  });


  // The scheme was pinned to 'light'. It follows the shell now, or a dark shell
  // would frame a white chat. The shell's own `system` is already resolved by
  // `appearance.scheme()`, so the two can never disagree.
  createEffect(() => theme.setColorScheme(appearance.scheme()));

  // opencode writes its palette to a <style id="oc-theme"> on :root and the
  // html element, and leaves both behind when the chat unmounts. Its provider
  // rewrites them on the next mount, so dropping them here costs nothing and
  // keeps a disposed chat's color-scheme and background off the shell. Only
  // the last chat standing may drop them: a sibling still mounted would lose
  // its palette until its next theme change.
  mountedChats += 1;
  onCleanup(() => {
    mountedChats -= 1;
    if (mountedChats > 0) return;
    document.getElementById('oc-theme')?.remove();
    const html = document.documentElement;
    html.style.removeProperty('background-color');
    delete html.dataset.theme;
    delete html.dataset.colorScheme;
  });

  pinModelVisibilityToCatalog(
    untrack(() => props.server),
    () => props.reachableModels()
  );

  return null;
}
