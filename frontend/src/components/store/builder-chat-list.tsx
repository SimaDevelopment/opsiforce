import { For, Show } from 'solid-js';
import { useNavigate } from '@tanstack/solid-router';
import { Badge } from '~/components/ui/badge';
import { Bot, ChevronRight, Files, Globe, Lock, MessageSquare } from '~/components/icons';
import { formatAgo } from '~/lib/format-duration';
import { useNow } from '~/lib/use-now';
import { cn } from '~/lib/cn';
import {
  CHAT_KIND_LABEL,
  isTestProjectRunning,
  type BuilderChat,
  type ChatKind,
  type ProducedArtifact,
} from '~/api/builder';
import { EmptyState, FOCUS_RING, RowList } from './store-list';

const CLOCK_TICK_MS = 30_000;

export function builderChatTitle(chat: BuilderChat): string {
  return chat.title?.trim() || (chat.kind === 'skill_builder_chat' ? 'New Skill' : 'New Agent');
}

/** The moment a row is sorted and stamped by: the last prompt, or the chat's birth if none. */
export function builderChatActivityAt(chat: BuilderChat): number {
  return new Date(chat.lastPromptAt ?? chat.createdAt).getTime();
}

function lockedReason(chat: BuilderChat): string {
  const creator = chat.createdBy?.displayName;
  return creator ? `private to ${creator}` : 'private to its creator';
}

function VisibilityMark(props: { chat: BuilderChat; class?: string }) {
  const isPublic = () => props.chat.visibility === 'public';
  return (
    <span
      class="inline-flex shrink-0"
      title={isPublic() ? 'Public — anyone in the organization can open it' : 'Private — only its creator can open it'}
    >
      <Show when={isPublic()} fallback={<Lock class={props.class} aria-hidden="true" />}>
        <Globe class={props.class} aria-hidden="true" />
      </Show>
      <span class="sr-only">{isPublic() ? 'Public' : 'Private'}</span>
    </span>
  );
}

function TestProjectDot(props: { chat: BuilderChat }) {
  return (
    <Show when={isTestProjectRunning(props.chat)}>
      <span class="h-2 w-2 shrink-0 rounded-full bg-sky-500" aria-hidden="true" title="Test project running" />
    </Show>
  );
}

export function KindIcon(props: { kind: ChatKind; class?: string }) {
  return (
    <Show when={props.kind === 'agent_builder_chat'} fallback={<Files class={props.class} aria-hidden="true" />}>
      <Bot class={props.class} aria-hidden="true" />
    </Show>
  );
}

export function BuilderChatList(props: {
  chats: BuilderChat[];
  variant: 'rail' | 'page';
  activeChatId?: string;
  onOpen?: (chat: BuilderChat) => void;
}) {
  const navigate = useNavigate();
  const now = useNow(CLOCK_TICK_MS);
  const open = (chat: BuilderChat) => {
    if (props.onOpen) {
      props.onOpen(chat);
      return;
    }
    navigate({
      to: '/store/builder/$id',
      params: { id: chat.id },
      search: { prompt: undefined, promptId: undefined },
    });
  };

  return (
    <Show when={props.variant === 'rail'} fallback={<PageRows {...props} now={now()} onOpen={open} />}>
      <RailRows {...props} now={now()} onOpen={open} />
    </Show>
  );
}

function RailRows(props: {
  chats: BuilderChat[];
  activeChatId?: string;
  now: number;
  onOpen: (chat: BuilderChat) => void;
}) {
  return (
    <div class="mt-3 flex min-h-0 flex-col gap-0.5 border-t border-sidebar-border pt-3">
      <div class="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-sidebar-muted-foreground">
        Chats
      </div>
      <Show
        when={props.chats.length > 0}
        fallback={<p class="px-2 py-1 text-xs text-sidebar-muted-foreground">No chats yet.</p>}
      >
        <ul class="flex min-h-0 flex-col gap-0.5 overflow-y-auto">
          <For each={props.chats}>
            {(chat) => (
              <li>
                <button
                  type="button"
                  disabled={!chat.canOpen}
                  aria-current={props.activeChatId === chat.id ? 'page' : undefined}
                  onClick={() => props.onOpen(chat)}
                  title={chat.canOpen ? undefined : lockedReason(chat)}
                  class={cn(
                    'flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
                    FOCUS_RING,
                    chat.canOpen
                      ? 'hover:bg-sidebar-accent/60'
                      : 'cursor-not-allowed text-sidebar-muted-foreground opacity-70',
                    props.activeChatId === chat.id && 'bg-sidebar-accent text-sidebar-accent-foreground'
                  )}
                >
                  <Show when={chat.canOpen} fallback={<Lock class="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />}>
                    <KindIcon kind={chat.kind} class="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  </Show>
                  <span class="min-w-0 flex-1">
                    <span class="flex items-center gap-1.5">
                      <span class="truncate text-xs font-medium">{builderChatTitle(chat)}</span>
                      <VisibilityMark chat={chat} class="h-3 w-3 shrink-0 text-sidebar-muted-foreground" />
                      <TestProjectDot chat={chat} />
                      <Show when={isTestProjectRunning(chat)}>
                        <span class="sr-only">Test project running</span>
                      </Show>
                    </span>
                    <span class="mt-0.5 block truncate text-[11px] text-sidebar-muted-foreground">
                      {CHAT_KIND_LABEL[chat.kind]} · {formatAgo(Math.max(0, props.now - builderChatActivityAt(chat)))}
                      <Show when={!chat.canOpen}> · {chat.createdBy?.displayName ?? 'another member'}</Show>
                    </span>
                  </span>
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}

function PageRows(props: {
  chats: BuilderChat[];
  activeChatId?: string;
  now: number;
  onOpen: (chat: BuilderChat) => void;
}) {
  return (
    <RowList>
      <For each={props.chats}>
        {(chat) => (
          <div
            role="presentation"
            onClick={() => chat.canOpen && props.onOpen(chat)}
            class={cn(
              'flex w-full items-center gap-3 p-4 first:rounded-t-xl last:rounded-b-xl',
              chat.canOpen && 'cursor-pointer transition-colors hover:bg-accent/40'
            )}
          >
            <Show when={chat.canOpen} fallback={<Lock class="h-4 w-4 shrink-0 text-muted-foreground" />}>
              <KindIcon kind={chat.kind} class="h-4 w-4 shrink-0 text-muted-foreground" />
            </Show>
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                <Show
                  when={chat.canOpen}
                  fallback={<span class="text-sm font-medium text-muted-foreground">{builderChatTitle(chat)}</span>}
                >
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      props.onOpen(chat);
                    }}
                    class={cn('rounded-sm text-left text-sm font-medium hover:underline', FOCUS_RING)}
                  >
                    {builderChatTitle(chat)}
                  </button>
                </Show>
                <Badge variant="outline" class="gap-1 font-medium">
                  <KindIcon kind={chat.kind} class="h-3 w-3" />
                  {CHAT_KIND_LABEL[chat.kind]}
                </Badge>
                <Show
                  when={chat.visibility === 'public'}
                  fallback={
                    <Badge variant="outline" class="gap-1 font-medium text-muted-foreground">
                      <Lock class="h-3 w-3" aria-hidden="true" />
                      Private
                    </Badge>
                  }
                >
                  <Badge variant="secondary" class="gap-1 font-medium">
                    <Globe class="h-3 w-3" aria-hidden="true" />
                    Public
                  </Badge>
                </Show>
                <Show when={chat.disabled}>
                  <Badge variant="outline" class="font-medium text-muted-foreground">
                    Archived
                  </Badge>
                </Show>
                <Show when={isTestProjectRunning(chat)}>
                  <span class="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <TestProjectDot chat={chat} />
                    Test project running
                  </span>
                </Show>
              </div>
              <div class="mt-0.5 text-xs text-muted-foreground">
                {chat.createdBy?.displayName ?? 'Unknown'} ·{' '}
                {formatAgo(Math.max(0, props.now - builderChatActivityAt(chat)))}
                <Show when={!chat.canOpen}> · {lockedReason(chat)}</Show>
              </div>
              <Show when={chat.produced.length > 0}>
                <div class="mt-2 flex flex-wrap gap-1.5">
                  <For each={chat.produced}>{(artifact) => <ProducedChip artifact={artifact} />}</For>
                </div>
              </Show>
            </div>
            <Show when={chat.canOpen}>
              <ChevronRight class="h-4 w-4 shrink-0 text-muted-foreground/50" aria-hidden="true" />
            </Show>
          </div>
        )}
      </For>
    </RowList>
  );
}

export function ProducedChip(props: { artifact: ProducedArtifact }) {
  const navigate = useNavigate();
  const href = () =>
    props.artifact.type === 'skill' ? `/store/skills/${props.artifact.id}` : `/store/agents/${props.artifact.id}`;

  return (
    <a
      href={href()}
      onClick={(event) => {
        event.stopPropagation();
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        navigate({ to: href() });
      }}
      class={cn(
        'inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent',
        FOCUS_RING
      )}
    >
      <Show when={props.artifact.type === 'agent'} fallback={<Files class="h-3 w-3" aria-hidden="true" />}>
        <Bot class="h-3 w-3" aria-hidden="true" />
      </Show>
      {props.artifact.name}
    </a>
  );
}

export function BuilderChatsEmpty(props: { hint: string }) {
  return <EmptyState icon={MessageSquare} title="No chats here yet." hint={props.hint} />;
}
