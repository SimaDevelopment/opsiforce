import { createEffect, onMount, untrack } from 'solid-js';
import { useTheme } from '@opencode-ai/ui/theme/context';
import { useSettings } from '@opencode-ai/app/settings/model';
import { useGlobal } from '@opencode-ai/app/runtime/server/runtime';
import type { ServerConnection } from '@opencode-ai/app';
import { timelinePresets, type TimelineDetail } from '@opencode-ai/session-ui/timeline/detail';
import { BASE_FORMAT_IDS } from '~/api/model-providers';

const detailedPreset = timelinePresets.find((preset) => preset.id === 'detailed');
if (!detailedPreset) throw new Error('opencode timeline presets no longer include "detailed"');
const activityTimeline: TimelineDetail = {
  ...detailedPreset.value,
  shell: { placement: 'separate', details: 'collapsed' },
  edit: { placement: 'separate', details: 'collapsed' },
  thinking: { placement: 'separate', details: 'expanded' },
};

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

  onMount(() => {
    theme.setColorScheme('light');
    settings.appearance.setTabLayout('horizontal');
    settings.general.setShowFileTree(false);
    settings.general.setShowCustomAgents(true);
    settings.general.setTimelineDetail(activityTimeline);
    settings.general.setReleaseNotes(false);
  });

  pinModelVisibilityToCatalog(
    untrack(() => props.server),
    () => props.reachableModels()
  );

  return null;
}
