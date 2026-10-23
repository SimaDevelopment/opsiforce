import { For } from 'solid-js';
import type { AffectedAgent } from '~/api/model-providers';
import { ConfirmDialog } from '~/components/ui/confirm-dialog';

export function SwitchOffWarningDialog(props: {
  formatLabel: string;
  agents: AffectedAgent[] | null;
  onClose: () => void;
  onSaveAnyway: () => void;
}) {
  return (
    <ConfirmDialog
      open={props.agents !== null}
      onOpenChange={(open) => !open && props.onClose()}
      title={`No ${props.formatLabel} model provider will be on`}
      description={`These Agents use ${props.formatLabel} models, which stop working in your organization once you save. Saving doesn’t change the Agents themselves.`}
      confirmLabel="Save anyway"
      variant="destructive"
      onConfirm={() => props.onSaveAnyway()}
    >
      <ul class="max-h-48 space-y-1 overflow-y-auto overscroll-contain text-sm">
        <For each={props.agents ?? []}>
          {(agent) => (
            <li class="flex items-center justify-between gap-2">
              <span class="min-w-0 truncate" title={agent.name}>
                {agent.name}
              </span>
              <span class="shrink-0 text-xs text-muted-foreground">
                {agent.origin === 'built_in' ? 'Built-in Agent' : 'Custom Agent'}
              </span>
            </li>
          )}
        </For>
      </ul>
    </ConfirmDialog>
  );
}
