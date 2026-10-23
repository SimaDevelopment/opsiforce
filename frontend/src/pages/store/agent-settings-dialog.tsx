import { Show, createEffect, createSignal, on, untrack } from 'solid-js';
import { toast } from 'solid-sonner';
import { useUpdateAgentPodClass, useUpdateAgentSettings, type AgentDetail } from '~/api/agents';
import { ApiError } from '~/api/client';
import { usePodClassCatalog } from '~/api/pod-classes';
import { createResourcesDraft } from '~/components/resources/resources-draft';
import { ResourcesSelector } from '~/components/resources/resources-selector';
import { WarmPoolPicker } from '~/components/resources/warm-pool-picker';
import { Button } from '~/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '~/components/ui/dialog';

export function AgentSettingsDialog(props: {
  agent: AgentDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [warmPoolSize, setWarmPoolSize] = createSignal(0);
  const podDraft = createResourcesDraft();
  const catalog = usePodClassCatalog(() => props.open);
  const updatePodClass = useUpdateAgentPodClass(() => props.agent.id);
  const updateSettings = useUpdateAgentSettings(() => props.agent.id);

  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return;
        const agent = untrack(() => props.agent);
        podDraft.reset(agent.podSettings);
        setWarmPoolSize(agent.settings.warmPoolSize);
      }
    )
  );

  const saving = () => updatePodClass.isPending || updateSettings.isPending;
  const warmPoolDirty = () => warmPoolSize() !== props.agent.settings.warmPoolSize;
  const canSave = () => (podDraft.dirty() || warmPoolDirty()) && !podDraft.limitError() && !saving();

  async function handleSave() {
    try {
      if (podDraft.dirty()) await updatePodClass.mutateAsync(podDraft.toDto());
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
        <DialogDescription>Applies to new Projects of this agent. Existing Projects keep their own.</DialogDescription>

        <div class="mt-4 min-h-0 space-y-5 overflow-y-auto pr-1">
          <section class="space-y-2">
            <span class="block text-xs font-medium text-foreground">Resources</span>
            <ResourcesSelector catalog={catalog.data} draft={podDraft} disabled={saving()} />
          </section>

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
        </div>

        <div class="mt-5 flex shrink-0 justify-end gap-2">
          <Button size="sm" variant="outline" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={!canSave()} onClick={() => void handleSave()}>
            {saving() ? 'Saving...' : 'Save'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
