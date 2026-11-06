import { For, Match, Show, Switch, createEffect, createSignal, on } from 'solid-js';
import { toast } from 'solid-sonner';
import {
  connectedMainDomain,
  useCustomDomains,
  useMakeMainCustomDomain,
  useRemoveCustomDomain,
  type CustomDomain,
  type CustomDomains,
  type EnvironmentRef,
} from '~/api/custom-domains';
import type { ProjectEnvironment } from '~/api/environments';
import { usePermissions } from '~/api/permissions';
import { CopyButton } from '~/components/external-service-form/copy-button';
import { Plus } from '~/components/icons';
import { Button } from '~/components/ui/button';
import { ConfirmDialog } from '~/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '~/components/ui/dialog';
import { Skeleton } from '~/components/ui/skeleton';
import { useNow } from '~/lib/use-now';
import { AddDomainForm } from './add-domain-form';
import { DomainRow } from './domain-row';
import { SignInCallbackNote } from './sign-in-callback-note';

export interface DomainsDialogProps {
  projectId: string;
  environment: ProjectEnvironment | null;
  onOpenChange: (open: boolean) => void;
}

type Usage = CustomDomains['usage'];

const CLOCK_TICK_MS = 5_000;

function atLimit(usage: Usage): boolean {
  return usage.limit !== null && usage.used >= usage.limit;
}

function publicUrlAfterRemoving(domain: CustomDomain, domains: CustomDomain[]): string {
  if (!domain.isMain) return '';
  const successor = domains.find((other) => other.id !== domain.id && other.status === 'connected');
  if (!successor) return ' The Public URL goes back to the Default address.';
  return ` ${successor.displayHostname} becomes the Main domain and the Public URL.`;
}

function removeDescription(domain: CustomDomain, domains: CustomDomain[]): string {
  return `${domain.displayHostname} is taken off this App.${publicUrlAfterRemoving(domain, domains)} Delete its DNS record at your DNS provider too.`;
}

function usageLine(usage: Usage): string {
  if (usage.limit === null) {
    return `${usage.used} custom ${usage.used === 1 ? 'domain' : 'domains'} used in your Organization`;
  }
  return `${usage.used} of ${usage.limit} custom domains used in your Organization`;
}

export function DomainsDialog(props: DomainsDialogProps) {
  const { hasPermission } = usePermissions();
  const canManage = () => hasPermission('can_manage_custom_domains');
  const environmentRef = (): EnvironmentRef => ({
    projectId: props.projectId,
    environmentId: props.environment?.id ?? '',
  });
  const domains = useCustomDomains(environmentRef, {
    enabled: () => props.environment !== null,
    refreshes: canManage,
  });
  const removeDomain = useRemoveCustomDomain();
  const makeMainDomain = useMakeMainCustomDomain();
  const now = useNow(CLOCK_TICK_MS);
  const [adding, setAdding] = createSignal(false);
  const [removing, setRemoving] = createSignal<CustomDomain | null>(null);
  const [promoting, setPromoting] = createSignal<CustomDomain | null>(null);

  createEffect(
    on(
      () => props.environment?.id,
      () => {
        setAdding(false);
        setRemoving(null);
        setPromoting(null);
      }
    )
  );

  const confirmRemove = () => {
    const domain = removing();
    if (!domain) return;
    removeDomain.mutate(
      { ...environmentRef(), domainId: domain.id },
      {
        onSuccess: () => toast.success(`${domain.displayHostname} removed`),
        onError: (err) =>
          toast.error(err instanceof Error ? err.message : `Failed to remove ${domain.displayHostname}`),
      }
    );
  };

  const removingDescription = () => {
    const domain = removing();
    return domain ? removeDescription(domain, domains.data?.items ?? []) : '';
  };

  const makeMain = (domain: CustomDomain) =>
    makeMainDomain.mutate(
      { ...environmentRef(), domainId: domain.id },
      {
        onSuccess: () => toast.success(`${domain.displayHostname} is now the Main domain`),
        onError: (err) =>
          toast.error(err instanceof Error ? err.message : `Failed to make ${domain.displayHostname} the Main domain`),
      }
    );

  const askToMakeMain = (domain: CustomDomain) => {
    if (domain.signInCallback) setPromoting(domain);
    else makeMain(domain);
  };

  return (
    <Dialog
      open={props.environment !== null}
      onOpenChange={(open) => {
        if (!open) props.onOpenChange(false);
      }}
    >
      <DialogContent class="max-w-2xl overscroll-contain">
        <DialogTitle>Domains</DialogTitle>
        <DialogDescription>
          Serve the {props.environment?.name} App at addresses on domains you own. You add one DNS record at your DNS
          provider; the platform does the rest, https included.
        </DialogDescription>
        <Switch
          fallback={
            <div class="mt-4 space-y-2">
              <Skeleton class="h-8 w-full" />
              <Skeleton class="h-14 w-full" />
            </div>
          }
        >
          <Match when={domains.isError}>
            <div class="of-note of-tone-failed mt-4 items-center text-xs">
              <p class="min-w-0 flex-1">Couldn't load the domains of this App.</p>
              <Button
                variant="outline"
                size="sm"
                class="h-7 shrink-0"
                loading={domains.isFetching}
                onClick={() => void domains.refetch()}
              >
                Retry
              </Button>
            </div>
          </Match>
          <Match when={domains.data}>
            {(data) => (
              <div class="mt-4 space-y-3">
                <div class="flex items-center gap-1.5 rounded-md bg-muted/40 px-2.5 py-1.5 text-xs">
                  <span class="shrink-0 text-muted-foreground">Public URL</span>
                  <span class="min-w-0 flex-1 break-all font-mono text-foreground" translate="no">
                    {props.environment?.publicUrl}
                  </span>
                  <CopyButton text={props.environment?.publicUrl ?? ''} label="Copy Public URL" />
                </div>

                <div class="space-y-1.5">
                  <div class="rounded-md border border-dashed border-border px-2.5 py-2">
                    <div class="flex items-center gap-1.5">
                      <span class="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" translate="no">
                        https://{data().defaultAddress}/
                      </span>
                      <span class="inline-flex shrink-0 items-center rounded bg-muted px-1.5 py-0.5 text-[0.625rem] font-medium uppercase tracking-wide text-muted-foreground">
                        Default address
                      </span>
                    </div>
                    <p class="mt-0.5 text-xs text-muted-foreground">
                      Always reaches the App. Your DNS records point here.
                    </p>
                  </div>

                  <For each={data().items}>
                    {(domain) => (
                      <DomainRow
                        environment={environmentRef()}
                        domain={domain}
                        mainDomain={connectedMainDomain(data().items)}
                        canManage={canManage()}
                        now={now()}
                        onMakeMain={() => askToMakeMain(domain)}
                        onRemove={() => setRemoving(domain)}
                      />
                    )}
                  </For>

                  <Show when={data().items.length === 0 && !canManage()}>
                    <p class="px-1 py-2 text-xs text-muted-foreground">
                      No custom domains yet. People who can manage custom domains can add one here.
                    </p>
                  </Show>
                </div>

                <Show when={canManage()}>
                  <Show
                    when={!atLimit(data().usage)}
                    fallback={
                      <div class="of-note of-tone-needs-you text-xs">
                        Your Organization has all {data().usage.limit} custom domains it may have. Remove one, or ask
                        your platform admin to raise the Limit.
                      </div>
                    }
                  >
                    <Show
                      when={adding() || data().items.length === 0}
                      fallback={
                        <Button variant="outline" size="sm" class="w-full" onClick={() => setAdding(true)}>
                          <Plus class="h-3.5 w-3.5" aria-hidden="true" />
                          Add domain
                        </Button>
                      }
                    >
                      <div class="space-y-2 rounded-md border border-dashed border-border p-2.5">
                        <Show when={data().items.length === 0}>
                          <p class="text-xs font-medium text-foreground">Serve this App at your own domain</p>
                        </Show>
                        <AddDomainForm
                          environment={environmentRef()}
                          onAdded={() => setAdding(false)}
                          onCancel={data().items.length > 0 ? () => setAdding(false) : undefined}
                        />
                      </div>
                    </Show>
                  </Show>
                </Show>

                <p class="text-xs text-muted-foreground">{usageLine(data().usage)}</p>
              </div>
            )}
          </Match>
        </Switch>

        <ConfirmDialog
          open={removing() !== null}
          onOpenChange={(open) => {
            if (!open) setRemoving(null);
          }}
          title={`Remove ${removing()?.displayHostname ?? ''}?`}
          description={removingDescription()}
          confirmLabel="Remove"
          variant="destructive"
          onConfirm={confirmRemove}
        />
        <ConfirmDialog
          open={promoting() !== null}
          onOpenChange={(open) => {
            if (!open) setPromoting(null);
          }}
          title={`Make ${promoting()?.displayHostname ?? ''} the Main domain?`}
          description="It becomes the Public URL, and the App's other domains send visitors to it."
          confirmLabel="Make main"
          onConfirm={() => {
            const domain = promoting();
            if (domain) makeMain(domain);
          }}
        >
          <Show when={promoting()?.signInCallback}>
            {(callback) => (
              <div class="mt-3">
                <SignInCallbackNote callback={callback()} />
              </div>
            )}
          </Show>
        </ConfirmDialog>
      </DialogContent>
    </Dialog>
  );
}
