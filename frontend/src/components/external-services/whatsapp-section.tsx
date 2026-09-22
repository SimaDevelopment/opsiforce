import { createMemo, createSignal, For, Show } from 'solid-js';
import { toast } from 'solid-sonner';
import {
  useAllowlistWhatsappChat,
  useAvailableWhatsappChannels,
  useEnvironmentWhatsappChannels,
  useEnvironmentWhatsappChats,
  useRemoveWhatsappChat,
  type WhatsappAvailableChannel,
  type WhatsappChatOption,
} from '~/api/whatsapp-channels';
import { Button } from '~/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select';
import { Skeleton } from '~/components/ui/skeleton';
import { MessageSquare, Plus, RefreshCw, Trash2, Users } from '~/components/icons';
import type { EnvironmentSectionProps } from './environment-section-props';
import { LabeledTextField } from './labeled-text-field';

const CHAT_ID_PATTERN = /^[^\s@]+@[^\s@]+$/;

function channelLabel(channel: WhatsappAvailableChannel): string {
  return channel.label?.trim() || channel.channelId;
}

function chatLabel(chat: WhatsappChatOption): string {
  return chat.name?.trim() || chat.chatId;
}

export function WhatsappSection(props: EnvironmentSectionProps) {
  const registered = useAvailableWhatsappChannels(() => props.projectEnvironmentId);
  const wired = useEnvironmentWhatsappChannels(
    () => props.projectEnvironmentId,
    () => true
  );

  const allowlist = useAllowlistWhatsappChat();
  const remove = useRemoveWhatsappChat();

  const [channel, setChannel] = createSignal<WhatsappAvailableChannel | null>(null);
  const [manual, setManual] = createSignal(false);
  const [manualChannelId, setManualChannelId] = createSignal('');
  const [chatsRequested, setChatsRequested] = createSignal(false);
  const [selectedChat, setSelectedChat] = createSignal<WhatsappChatOption | null>(null);
  const [manualChatId, setManualChatId] = createSignal('');
  const [manualChatName, setManualChatName] = createSignal('');

  const channels = createMemo(() => registered.data ?? []);
  const wiredChannels = createMemo(() => wired.data ?? []);

  const channelId = () => (manual() ? manualChannelId().trim() : (channel()?.channelId ?? ''));

  const chats = useEnvironmentWhatsappChats(
    () => props.projectEnvironmentId,
    () => channel()?.channelId ?? null,
    chatsRequested
  );

  const chatId = () => (manual() ? manualChatId().trim() : (selectedChat()?.chatId ?? ''));
  const chatName = () => (manual() ? manualChatName().trim() || null : (selectedChat()?.name ?? null));
  const chatIdValid = () => CHAT_ID_PATTERN.test(chatId());
  const canSubmit = () => chatIdValid() && channelId() !== '';

  const submit = async () => {
    if (!canSubmit()) return;

    try {
      await allowlist.mutateAsync({
        projectEnvironmentId: props.projectEnvironmentId,
        channelId: channelId(),
        dto: { chatId: chatId(), chatName: chatName() },
      });
      toast.success('Chat allowlisted');
      setSelectedChat(null);
      setManualChatId('');
      setManualChatName('');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to allowlist the chat');
    }
  };

  const removeChat = (channelId: string, chat: string) => {
    remove.mutate(
      { projectEnvironmentId: props.projectEnvironmentId, channelId, chatId: chat },
      {
        onSuccess: () => toast.success('Chat removed'),
        onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to remove the chat'),
      }
    );
  };

  return (
    <div class="space-y-3">
      <Show when={!registered.isPending && !wired.isPending} fallback={<Skeleton class="h-8 w-full" />}>
        <>
          <Show when={channels().length === 0}>
            <p class="text-xs text-muted-foreground">
              No WhatsApp channel has been registered yet. Register one under Admin → External services, then pick it
              here to wire it to this environment.
            </p>
          </Show>

          <Show
            when={wiredChannels().length > 0}
            fallback={
              <p class="text-xs text-muted-foreground">
                No chats are allowlisted here yet. WhatsApp messages are dropped until a chat is mapped to this
                environment.
              </p>
            }
          >
            <div class="space-y-2">
              <For each={wiredChannels()}>
                {(entry) => (
                  <div class="rounded-md border border-border bg-background p-2">
                    <div class="flex items-center gap-2">
                      <span class="truncate text-xs font-medium">{entry.label ?? entry.channelId}</span>
                      <span class="truncate font-mono text-[11px] text-muted-foreground">{entry.channelId}</span>
                      <Show when={!entry.registered}>
                        <span class="ml-auto text-[11px] text-destructive">no longer registered</span>
                      </Show>
                    </div>
                    <div class="mt-1.5 space-y-1 pl-1">
                      <For each={entry.allowedChats}>
                        {(chat) => (
                          <div class="flex items-center gap-2">
                            <Show
                              when={chat.chatId.endsWith('@g.us')}
                              fallback={<MessageSquare class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                            >
                              <Users class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            </Show>
                            <span class="truncate text-xs">{chat.chatName ?? chat.chatId}</span>
                            <span class="truncate font-mono text-[11px] text-muted-foreground">{chat.chatId}</span>
                            <button
                              type="button"
                              onClick={() => removeChat(entry.channelId, chat.chatId)}
                              class="ml-auto inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-destructive"
                              aria-label={`Remove ${chat.chatId}`}
                            >
                              <Trash2 class="h-3.5 w-3.5" />
                            </button>
                          </div>
                        )}
                      </For>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </Show>

          <div class="space-y-2 rounded-md border border-dashed border-border p-2.5">
            <div class="flex items-center gap-2">
              <span class="text-xs font-medium">Allowlist a chat</span>
              <button
                type="button"
                onClick={() => setManual((prev) => !prev)}
                class="ml-auto text-xs text-muted-foreground underline-offset-4 hover:underline"
              >
                {manual() ? 'Pick from Whapi' : 'Enter an id manually'}
              </button>
            </div>

            <Show
              when={manual()}
              fallback={
                <div class="space-y-1">
                  <span class="block text-xs text-muted-foreground">Channel</span>
                  <Select
                    options={channels()}
                    optionValue="channelId"
                    optionTextValue="channelId"
                    value={channel()}
                    onChange={(value) => {
                      setChannel(value);
                      setChatsRequested(false);
                      setSelectedChat(null);
                    }}
                    itemComponent={(itemProps) => (
                      <SelectItem item={itemProps.item}>{channelLabel(itemProps.item.rawValue)}</SelectItem>
                    )}
                  >
                    <SelectTrigger aria-label="Channel">
                      <SelectValue<WhatsappAvailableChannel>>
                        {(state) => {
                          const selected = state.selectedOption();
                          return <span>{selected ? channelLabel(selected) : 'Select a channel'}</span>;
                        }}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent />
                  </Select>
                </div>
              }
            >
              <LabeledTextField
                label="Channel id"
                value={manualChannelId()}
                onInput={setManualChannelId}
                placeholder="paste the channel id you were given"
              />
            </Show>

            <Show
              when={manual()}
              fallback={
                <div class="space-y-1">
                  <Show
                    when={chatsRequested()}
                    fallback={
                      <Button
                        size="sm"
                        variant="outline"
                        class="w-full"
                        disabled={channel() === null}
                        onClick={() => setChatsRequested(true)}
                      >
                        <RefreshCw class="h-3.5 w-3.5" />
                        Load chats and groups from Whapi
                      </Button>
                    }
                  >
                    <Show when={!chats.isPending} fallback={<Skeleton class="h-8 w-full" />}>
                      <Show
                        when={!chats.isError}
                        fallback={
                          <div class="space-y-1">
                            <p class="text-xs text-destructive">
                              {chats.error instanceof Error ? chats.error.message : 'Could not reach Whapi'}
                            </p>
                            <Button size="sm" variant="outline" class="w-full" onClick={() => chats.refetch()}>
                              <RefreshCw class="h-3.5 w-3.5" />
                              Try again
                            </Button>
                          </div>
                        }
                      >
                        <span class="block text-xs text-muted-foreground">Chat</span>
                        <Select
                          options={chats.data ?? []}
                          optionValue="chatId"
                          optionTextValue="chatId"
                          value={selectedChat()}
                          onChange={setSelectedChat}
                          itemComponent={(itemProps) => (
                            <SelectItem item={itemProps.item}>
                              {chatLabel(itemProps.item.rawValue)}
                              <span class="ml-2 text-[10px] text-muted-foreground">{itemProps.item.rawValue.kind}</span>
                            </SelectItem>
                          )}
                        >
                          <SelectTrigger aria-label="Chat">
                            <SelectValue<WhatsappChatOption>>
                              {(state) => {
                                const chat = state.selectedOption();
                                return <span>{chat ? chatLabel(chat) : 'Select a chat or group'}</span>;
                              }}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent />
                        </Select>
                        <Show when={selectedChat()}>
                          {(chat) => <p class="font-mono text-[11px] text-muted-foreground">{chat().chatId}</p>}
                        </Show>
                      </Show>
                    </Show>
                  </Show>
                </div>
              }
            >
              <LabeledTextField
                label="Chat id"
                value={manualChatId()}
                onInput={setManualChatId}
                placeholder="1234567890@s.whatsapp.net or 1234567890@g.us"
                mono
                error={manualChatId().trim() && !chatIdValid() ? 'Expected a Whapi chat id with an @ suffix' : null}
              />
              <LabeledTextField
                label="Display name (optional)"
                value={manualChatName()}
                onInput={setManualChatName}
                placeholder="e.g. Ops group"
              />
            </Show>

            <div class="flex justify-end">
              <Button size="sm" onClick={submit} disabled={!canSubmit()} loading={allowlist.isPending}>
                <Plus class="h-3.5 w-3.5" />
                Allowlist
              </Button>
            </div>
          </div>
        </>
      </Show>
    </div>
  );
}
