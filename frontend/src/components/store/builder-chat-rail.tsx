import { Show } from 'solid-js';
import { useLocation } from '@tanstack/solid-router';
import { useBuilderChats } from '~/api/builder';
import { usePermissions } from '~/api/permissions';
import { Permission } from '~/constants/permissions';
import { BuilderChatList } from './builder-chat-list';

const CHAT_PATH = /^\/store\/builder\/([^/]+)/;

export function BuilderChatRail() {
  const location = useLocation();
  const { permissions, hasPermission } = usePermissions();
  const canUseBuilder = () =>
    !permissions.isPending && (hasPermission(Permission.manageSkills) || hasPermission(Permission.manageAgents));

  const chats = useBuilderChats(() => 'active', { enabled: canUseBuilder });
  const activeChatId = () => CHAT_PATH.exec(location().pathname)?.[1];

  return (
    <Show when={canUseBuilder() && chats.data}>
      {(rows) => <BuilderChatList chats={rows()} variant="rail" activeChatId={activeChatId()} />}
    </Show>
  );
}
