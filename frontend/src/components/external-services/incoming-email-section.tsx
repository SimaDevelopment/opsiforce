import { createSignal, Show } from 'solid-js';
import { toast } from 'solid-sonner';
import { ApiError } from '~/api/client';
import { useIncomingEmailAddress, useRegenerateIncomingEmailAddress } from '~/api/incoming-email';
import { Button } from '~/components/ui/button';
import { ConfirmDialog } from '~/components/ui/confirm-dialog';
import { Skeleton } from '~/components/ui/skeleton';
import { Copy, RotateCcw } from '~/components/icons';
import type { EnvironmentSectionProps } from './environment-section-props';

export function IncomingEmailSection(props: EnvironmentSectionProps) {
  const address = useIncomingEmailAddress(
    () => props.projectEnvironmentId,
    () => true
  );
  const regenerate = useRegenerateIncomingEmailAddress();

  const [confirming, setConfirming] = createSignal(false);

  const unconfigured = () => address.error instanceof ApiError && address.error.status === 503;

  const copy = async () => {
    const value = address.data?.address;
    if (!value) return;
    await navigator.clipboard.writeText(value);
    toast.success('Address copied');
  };

  const confirmRegenerate = () => {
    regenerate.mutate(props.projectEnvironmentId, {
      onSuccess: (result) => toast.success(`This environment now receives mail at ${result.address}`),
      onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to regenerate the address'),
    });
  };

  return (
    <div class="space-y-2">
      <Show when={!address.isPending} fallback={<Skeleton class="h-8 w-full" />}>
        <Show
          when={!address.isError}
          fallback={
            <p class="text-xs text-muted-foreground">
              {unconfigured()
                ? "Incoming email isn't configured on this platform."
                : address.error instanceof Error
                  ? address.error.message
                  : 'Could not load the incoming email address.'}
            </p>
          }
        >
          <div class="flex flex-wrap items-center gap-2">
            <code class="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-xs text-foreground">
              {address.data?.address}
            </code>
            <button
              type="button"
              onClick={copy}
              class="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              aria-label="Copy the incoming email address"
            >
              <Copy class="h-3.5 w-3.5" />
            </button>
            <Button size="sm" variant="outline" onClick={() => setConfirming(true)} loading={regenerate.isPending}>
              <RotateCcw class="h-3.5 w-3.5" />
              Regenerate
            </Button>
          </div>
          <p class="text-xs text-muted-foreground">
            Mail sent here is stored for this environment and the app is notified.
          </p>
        </Show>
      </Show>

      <ConfirmDialog
        open={confirming()}
        onOpenChange={setConfirming}
        title="Regenerate address"
        description="A new address is issued and the current one stops receiving mail immediately. Anyone who saved the old address has to be told the new one."
        confirmLabel="Regenerate"
        variant="destructive"
        onConfirm={confirmRegenerate}
      />
    </div>
  );
}
