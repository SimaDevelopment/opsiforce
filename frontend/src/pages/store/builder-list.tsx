import { Show } from 'solid-js';
import { usePermissions } from '~/api/permissions';
import { Permission } from '~/constants/permissions';
import { useBuilderChats, type BuilderChatFilter } from '~/api/builder';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { SettingsSection } from '~/components/settings/settings-section';
import { ErrorState, FilterChips } from '~/components/store/store-list';
import { BuilderChatList, BuilderChatsEmpty } from '~/components/store/builder-chat-list';
import { useStartBuilderChat } from '~/components/store/use-start-builder-chat';
import { Bot, Files, MessageSquare } from '~/components/icons';
import { BUILDER_FILTER_OPTIONS } from './store-filters';

const EMPTY_HINT: Record<BuilderChatFilter, string> = {
  active: 'Start one with New Skill or New Agent.',
  mine: 'Chats you start appear here.',
  archived: 'Archiving a chat keeps its transcript and moves it here.',
};

export function BuilderListPage(props: { filter: BuilderChatFilter; onFilter: (filter: BuilderChatFilter) => void }) {
  const chats = useBuilderChats(() => props.filter);

  return (
    <SettingsSection
      icon={MessageSquare}
      title="Skill & Agent Builder"
      description="Author skills and agents in chat, and test them in a real project. Every chat in this organization is listed here; a chat opens only for the member who started it until they make it public."
      width="wide"
      action={<NewChatButtons />}
    >
      <div class="mb-4">
        <FilterChips
          label="Filter chats"
          options={BUILDER_FILTER_OPTIONS}
          value={props.filter}
          onChange={props.onFilter}
        />
      </div>

      <Show when={!chats.isError} fallback={<ErrorState message="The Builder chats could not be loaded." />}>
        <Show
          when={chats.data}
          fallback={
            <div class="flex justify-center py-10">
              <Spinner />
            </div>
          }
        >
          {(rows) => (
            <Show when={rows().length > 0} fallback={<BuilderChatsEmpty hint={EMPTY_HINT[props.filter]} />}>
              <BuilderChatList chats={rows()} variant="page" />
            </Show>
          )}
        </Show>
      </Show>
    </SettingsSection>
  );
}

function NewChatButtons() {
  const { hasPermission } = usePermissions();
  const startChat = useStartBuilderChat();

  return (
    <div class="flex gap-2">
      <Show when={hasPermission(Permission.manageSkills)}>
        <Button
          size="sm"
          variant="outline"
          disabled={startChat.isPending}
          onClick={() => startChat.start('skill_builder_chat')}
        >
          <Files class="h-4 w-4" aria-hidden="true" />
          New Skill
        </Button>
      </Show>
      <Show when={hasPermission(Permission.manageAgents)}>
        <Button
          size="sm"
          variant="outline"
          disabled={startChat.isPending}
          onClick={() => startChat.start('agent_builder_chat')}
        >
          <Bot class="h-4 w-4" aria-hidden="true" />
          New Agent
        </Button>
      </Show>
    </div>
  );
}
