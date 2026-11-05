import { Show, createEffect, createSignal, on, untrack } from 'solid-js';
import { toast } from 'solid-sonner';
import {
  useResetAgentPodClass,
  useSetAgentPlatformPreset,
  useUpdateAgentPodClass,
  useUpdateAgentSettings,
  type AgentDetail,
} from '~/api/agents';
import { ApiError } from '~/api/client';
import { usePermissions } from '~/api/permissions';
import { usePodClassCatalog } from '~/api/pod-classes';
import { usePlatformPresets } from '~/api/resource-presets';
import { OptionSelect } from '~/components/resources/option-select';
import { createResourcesDraft } from '~/components/resources/resources-draft';
import { ResourcesSelector } from '~/components/resources/resources-selector';
import { WarmPoolPicker } from '~/components/resources/warm-pool-picker';
import { Button } from '~/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '~/components/ui/dialog';

const DEFAULT_PRESET = 'default-preset';

export function AgentSettingsDialog(props: {
  agent: AgentDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [warmPoolSize, setWarmPoolSize] = createSignal(0);
  const podDraft = createResourcesDraft();
  const updatePodClass = useUpdateAgentPodClass(() => props.agent.id);
  const resetPodClass = useResetAgentPodClass(() => props.agent.id);
  const updateSettings = useUpdateAgentSettings(() => props.agent.id);
  const setPlatformPreset = useSetAgentPlatformPreset(() => props.agent.id);
  const { hasPermission } = usePermissions();
  const builtIn = () => props.agent.origin === 'built_in';
  const editsOrganization = () => hasPermission('can_manage_agents');
  const editsPlatform = () => builtIn() && hasPermission('can_manage_platform_resources');
  const catalog = usePodClassCatalog(() => props.open && editsOrganization());
  const platformPresets = usePlatformPresets(() => props.open && editsPlatform());
  const [platformPreset, setPlatformPresetDraft] = createSignal(DEFAULT_PRESET);
  const platformOptions = () => [
    { value: DEFAULT_PRESET, label: 'Default preset' },
    ...(platformPresets.data?.presets ?? []).map((preset) => ({ value: preset.id, label: preset.name })),
  ];

  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return;
        const agent = untrack(() => props.agent);
        podDraft.reset(agent.podSettings, agent.podSettingsSource !== 'own');
        setWarmPoolSize(agent.settings.warmPoolSize);
        setPlatformPresetDraft(agent.platformPresetId ?? DEFAULT_PRESET);
      }
    )
  );

  const inherited = () => ({
    label: builtIn() && props.agent.podSettingsSource !== 'default' ? 'Platform value' : 'Default',
    settings: props.agent.inheritedPodSettings,
  });
  const saving = () =>
    updatePodClass.isPending || resetPodClass.isPending || updateSettings.isPending || setPlatformPreset.isPending;
  const warmPoolDirty = () => !builtIn() && warmPoolSize() !== props.agent.settings.warmPoolSize;
  const platformDirty = () => editsPlatform() && platformPreset() !== (props.agent.platformPresetId ?? DEFAULT_PRESET);
  const canSave = () => (podDraft.dirty() || warmPoolDirty() || platformDirty()) && !podDraft.limitError() && !saving();

  async function handleSave() {
    try {
      if (podDraft.dirty()) {
        if (podDraft.inherits()) await resetPodClass.mutateAsync();
        else await updatePodClass.mutateAsync(podDraft.toDto());
      }
      if (platformDirty()) {
        await setPlatformPreset.mutateAsync(platformPreset() === DEFAULT_PRESET ? null : platformPreset());
      }
      if (warmPoolDirty()) await updateSettings.mutateAsync({ warmPoolSize: warmPoolSize() });
      toast.success('Agent settings saved');
      props.onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Failed to save settings');
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent align="top" class="flex max-h-[85vh] max-w-xl flex-col">
        <DialogTitle>Agent Settings</DialogTitle>
        <DialogDescription>
          {!builtIn()
            ? 'Applies to new Projects of this agent. Existing Projects keep their own.'
            : editsOrganization()
              ? "Applies to this organization's new Projects of this agent. Existing Projects keep their own."
              : 'Applies to new Projects of this agent in every organization without its own choice. Existing Projects keep their own.'}
        </DialogDescription>

        <div class="mt-4 min-h-0 space-y-5 overflow-y-auto pr-1">
          <Show when={editsOrganization()}>
            <section class="space-y-2">
              <span class="block text-xs font-medium text-foreground">
                {builtIn() ? 'Resources in this organization' : 'Resources'}
              </span>
              <ResourcesSelector catalog={catalog.data} draft={podDraft} disabled={saving()} inherited={inherited()} />
            </section>
          </Show>

          <Show when={editsPlatform()}>
            <section class={editsOrganization() ? 'space-y-2 border-t border-border pt-4' : 'space-y-2'}>
              <div class="flex items-center justify-between gap-4">
                <div class="space-y-0.5">
                  <span class="block text-xs font-medium text-foreground">Platform value</span>
                  <span class="block text-xs text-muted-foreground">
                    What every organization without its own choice gets.
                  </span>
                </div>
                <div class="w-56 shrink-0">
                  <OptionSelect
                    ariaLabel="Platform value"
                    options={platformOptions()}
                    value={platformPreset()}
                    disabled={saving()}
                    onChange={setPlatformPresetDraft}
                  />
                </div>
              </div>
            </section>
          </Show>

          <Show when={!builtIn()}>
            <section class="space-y-2 border-t border-border pt-4">
              <WarmPoolPicker
                value={warmPoolSize()}
                max={props.agent.settings.maxWarmPoolSize}
                countedAlready={props.agent.settings.warmPoolSize}
                disabled={saving()}
                onChange={setWarmPoolSize}
              />
              <Show when={warmPoolSize() > 0 && (props.agent.disabled || !props.agent.live)}>
                <p class="text-xs text-muted-foreground/70">
                  None are kept ready until the agent is enabled and published to its default environment.
                </p>
              </Show>
            </section>
          </Show>
        </div>

        <div class="mt-5 flex shrink-0 justify-end gap-2">
          <Button size="sm" variant="outline" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={!canSave()} onClick={() => void handleSave()}>
            {saving() ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
