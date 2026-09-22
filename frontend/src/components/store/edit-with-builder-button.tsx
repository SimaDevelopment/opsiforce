import { Show } from 'solid-js';
import { usePermissions } from '~/api/permissions';
import type { BuilderSeed } from '~/api/builder';
import { Permission } from '~/constants/permissions';
import { Button } from '~/components/ui/button';
import { MessageSquare } from '~/components/icons';
import { useStartBuilderChat } from './use-start-builder-chat';

export function EditWithBuilderButton(props: { seed: BuilderSeed }) {
  const { hasPermission } = usePermissions();
  const startChat = useStartBuilderChat();
  const isSkill = () => 'skillId' in props.seed;
  const permitted = () => hasPermission(isSkill() ? Permission.manageSkills : Permission.manageAgents);

  return (
    <Show when={permitted()}>
      <Button
        size="sm"
        variant="outline"
        disabled={startChat.isPending}
        onClick={() => startChat.startWithSeed(isSkill() ? 'skill_builder_chat' : 'agent_builder_chat', props.seed)}
      >
        <MessageSquare class="h-4 w-4" aria-hidden="true" />
        Edit with Builder
      </Button>
    </Show>
  );
}
