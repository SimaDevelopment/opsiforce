import { createMemo, createSignal, For, Show } from 'solid-js';
import { toast } from 'solid-sonner';
import {
  useDeleteWhatsappChannel,
  useRotateWhatsappSecret,
  useWhatsappChannels,
  type WhatsappChannel,
} from '~/api/whatsapp-channels';
import { Button } from '~/components/ui/button';
import { ConfirmDialog } from '~/components/ui/confirm-dialog';
import { Skeleton } from '~/components/ui/skeleton';
import { MessageSquare, Plus } from '~/components/icons';
import { ChannelCard } from './channel-card';
import { ChannelDialog } from './channel-dialog';

export function WhatsappResourcesSection() {
  const channels = useWhatsappChannels();
  const remove = useDeleteWhatsappChannel();
  const rotate = useRotateWhatsappSecret();

  const [dialogOpen, setDialogOpen] = createSignal(false);
  const [editing, setEditing] = createSignal<WhatsappChannel | null>(null);
  const [pendingDelete, setPendingDelete] = createSignal<WhatsappChannel | null>(null);
  const [pendingRotate, setPendingRotate] = createSignal<WhatsappChannel | null>(null);

  const rows = createMemo(() => channels.data ?? []);

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };

  const confirmDelete = () => {
    const channel = pendingDelete();
    if (!channel) return;
    remove.mutate(channel.channelId, {
      onSuccess: () => toast.success('Channel deleted'),
      onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to delete the channel'),
    });
  };

  const confirmRotate = () => {
    const channel = pendingRotate();
    if (!channel) return;
    rotate.mutate(channel.channelId, {
      onSuccess: () => toast.success('Webhook secret rotated and pushed to Whapi'),
      onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to rotate the webhook secret'),
    });
  };

  return (
    <div class="space-y-2">
      <div class="flex items-center gap-2">
        <p class="text-xs text-muted-foreground">
          Whapi channels registered on this platform. Create and QR-link the channel in the Whapi dashboard first, then
          register it here — the webhook is configured automatically. Chats are allowlisted per environment from the
          project page.
        </p>
        <Button size="sm" class="ml-auto shrink-0" onClick={openCreate}>
          <Plus class="h-3.5 w-3.5" />
          Add channel
        </Button>
      </div>

      <Show when={!channels.isPending} fallback={<Skeleton class="h-16 w-full" />}>
        <Show when={!channels.isError} fallback={<p class="text-xs text-destructive">Could not load channels.</p>}>
          <Show
            when={rows().length > 0}
            fallback={
              <div class="flex flex-col items-center gap-2 rounded-lg border border-border bg-card p-8 text-center">
                <MessageSquare class="h-6 w-6 text-muted-foreground" />
                <p class="text-sm font-medium">No channels registered</p>
                <p class="text-xs text-muted-foreground">
                  Register a Whapi channel to start routing WhatsApp messages into environments.
                </p>
              </div>
            }
          >
            <div class="space-y-2">
              <For each={rows()}>
                {(channel) => (
                  <ChannelCard
                    channel={channel}
                    onEdit={() => {
                      setEditing(channel);
                      setDialogOpen(true);
                    }}
                    onRotateSecret={() => setPendingRotate(channel)}
                    onDelete={() => setPendingDelete(channel)}
                  />
                )}
              </For>
            </div>
          </Show>
        </Show>
      </Show>

      <ChannelDialog open={dialogOpen()} onOpenChange={setDialogOpen} channel={editing()} />

      <ConfirmDialog
        open={pendingRotate() !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRotate(null);
        }}
        title="Rotate webhook secret"
        description={`Generates a new secret for ${pendingRotate()?.channelId ?? ''} and pushes it to Whapi in the same step. If the push fails, the old secret stays active.`}
        confirmLabel="Rotate"
        variant="destructive"
        onConfirm={confirmRotate}
      />

      <ConfirmDialog
        open={pendingDelete() !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title="Delete channel"
        description={`This unregisters channel ${pendingDelete()?.channelId ?? ''}. Messages from it will no longer be stored. Environments still referencing it must drop it first.`}
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={confirmDelete}
      />
    </div>
  );
}
