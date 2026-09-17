import { createEffect, onMount, untrack } from 'solid-js';
import { useTheme } from '@opencode-ai/ui/theme/context';
import { useSettings } from '@opencode-ai/app/settings/model';
import { useGlobal } from '@opencode-ai/app/runtime/server/runtime';
import type { ServerConnection } from '@opencode-ai/app';
import { timelinePresets, type TimelineDetail } from '@opencode-ai/session-ui/timeline/detail';

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

const visibilityKey = (model: ModelKey) => `${model.providerID}:${model.modelID}`;

// Models still served by pods running an agent image whose models.json predates their removal.
// Dropping them from the catalog only reaches a pod on its next recreate, so hide them here until
// the next agent image bump has rolled out, then delete the entry.
const HIDDEN_UNTIL_NEXT_AGENT_IMAGE: ReadonlySet<string> = new Set([
  visibilityKey({ providerID: 'openai', modelID: 'gpt-6-astra-fast' }),
]);

const desiredVisibility = (model: ModelKey): Visibility =>
  HIDDEN_UNTIL_NEXT_AGENT_IMAGE.has(visibilityKey(model)) ? 'hide' : 'show';

const pinnedEntry = (model: ModelKey) => ({ ...model, visibility: desiredVisibility(model) });

function pinModelVisibilityToCatalog(server: ServerConnection.Any) {
  const global = useGlobal();
  const ctx = global.ensureServerCtx(server);

  createEffect(() => {
    const location = ctx.data.location.default();
    const served = location ? ctx.data.location.model.list(location) : undefined;
    if (!served) return;
    const current = new Map(global.models.store.user.map((entry) => [visibilityKey(entry), entry.visibility]));
    const changes = served
      .filter((model) => model.status !== 'deprecated')
      .map((model) => pinnedEntry({ providerID: model.providerID, modelID: model.id }))
      .filter((model) => current.get(visibilityKey(model)) !== model.visibility);
    if (changes.length === 0) return;
    const changed = new Set(changes.map(visibilityKey));
    global.models.set('user', (user) => [...user.filter((entry) => !changed.has(visibilityKey(entry))), ...changes]);
  });
}

export function OpencodeOverrides(props: { server: ServerConnection.Any }) {
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

  pinModelVisibilityToCatalog(untrack(() => props.server));

  return null;
}
