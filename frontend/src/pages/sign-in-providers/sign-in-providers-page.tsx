import { For, Show, createSignal } from 'solid-js';
import { toast } from '~/lib/toast';
import { useDeleteSignInProvider, useSignInProviders, type SignInProvider } from '~/api/sign-in-providers';
import { ActionsMenu, ActionsMenuItem } from '~/components/actions-menu';
import { KeyRound, Pencil, Plus, Trash2 } from '~/components/icons';
import { SettingsSection } from '~/components/settings/settings-section';
import { Button } from '~/components/ui/button';
import { ConfirmDialog } from '~/components/ui/confirm-dialog';
import { Skeleton } from '~/components/ui/skeleton';
import { RedirectUri, SignInProviderDialog } from './sign-in-provider-dialog';

function issuerHost(discoveryUrl: string): string {
  try {
    return new URL(discoveryUrl).host;
  } catch {
    return discoveryUrl;
  }
}

function usageLabel(count: number): string {
  if (count === 0) return 'Not used by any app yet';
  return count === 1 ? 'Protects 1 app environment' : `Protects ${count} app environments`;
}

function ProviderRow(props: {
  provider: SignInProvider;
  onEdit: (provider: SignInProvider) => void;
  onDelete: (provider: SignInProvider) => void;
}) {
  return (
    <div class="space-y-3 rounded-lg border border-border p-3">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0 space-y-0.5">
          <p class="truncate text-sm font-medium text-foreground">{props.provider.name}</p>
          <p class="truncate text-xs text-muted-foreground">
            {issuerHost(props.provider.discoveryUrl)} · client <span class="font-mono">{props.provider.clientId}</span>
          </p>
          <Show when={props.provider.requiredClaimName}>
            {(claim) => (
              <p class="truncate text-xs text-muted-foreground">
                Requires <span class="font-mono">{claim()}</span>
                <Show when={props.provider.requiredClaimValues.length > 0}>
                  {' '}
                  to include {props.provider.requiredClaimValues.join(' or ')}
                </Show>
              </p>
            )}
          </Show>
          <p class="text-xs text-muted-foreground">{usageLabel(props.provider.environmentCount)}</p>
        </div>
        <ActionsMenu label={`Actions for ${props.provider.name}`}>
          <ActionsMenuItem icon={Pencil} onSelect={() => props.onEdit(props.provider)}>
            Edit
          </ActionsMenuItem>
          <ActionsMenuItem icon={Trash2} destructive onSelect={() => props.onDelete(props.provider)}>
            Delete
          </ActionsMenuItem>
        </ActionsMenu>
      </div>
      <RedirectUri value={props.provider.redirectUri} />
    </div>
  );
}

export function SignInProvidersPage() {
  const providers = useSignInProviders();
  const remove = useDeleteSignInProvider();
  const [editing, setEditing] = createSignal<SignInProvider | null>(null);
  const [dialogOpen, setDialogOpen] = createSignal(false);
  const [pendingDelete, setPendingDelete] = createSignal<SignInProvider | null>(null);

  const openDialog = (provider: SignInProvider | null) => {
    setEditing(provider);
    setDialogOpen(true);
  };

  const confirmDelete = () => {
    const provider = pendingDelete();
    if (!provider) return;
    remove.mutate(provider.id, {
      onSuccess: () => toast.success(`${provider.name} deleted`),
      onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to delete the provider'),
    });
  };

  return (
    <SettingsSection
      icon={KeyRound}
      title="Sign-in providers"
      description="Your organization's members sign in to apps with these. Add one once; project owners choose it in App Auth without handling any secret."
      action={
        <Button size="sm" onClick={() => openDialog(null)}>
          <Plus class="h-3.5 w-3.5" />
          Add sign-in provider
        </Button>
      }
    >
      <div class="space-y-4">
        <Show
          when={!providers.isPending}
          fallback={
            <div class="space-y-2">
              <Skeleton class="h-16 w-full" />
              <Skeleton class="h-16 w-full" />
            </div>
          }
        >
          <Show
            when={(providers.data?.length ?? 0) > 0}
            fallback={
              <div class="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                No sign-in providers yet. Add the OIDC app that holds your organization's members.
              </div>
            }
          >
            <div class="space-y-2">
              <For each={providers.data}>
                {(provider) => <ProviderRow provider={provider} onEdit={openDialog} onDelete={setPendingDelete} />}
              </For>
            </div>
          </Show>
        </Show>
      </div>

      <SignInProviderDialog provider={editing()} open={dialogOpen()} onOpenChange={setDialogOpen} />

      <ConfirmDialog
        open={pendingDelete() !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title="Delete sign-in provider"
        description={`This deletes ${pendingDelete()?.name ?? ''}. A provider that still protects an app cannot be deleted; switch those apps to another App Auth mode first.`}
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={confirmDelete}
      />
    </SettingsSection>
  );
}
