import { For, Show, createMemo, createSignal } from 'solid-js';
import { toast } from 'solid-sonner';
import { ApiError } from '~/api/client';
import {
  usePlatformModelProviderAccess,
  useRewriteEveryOrganizationsKeys,
  useSetAvailabilityMode,
  useSetModelProviderAccess,
  type AvailabilityMode,
  type PlatformModelProviderAccess,
  type TenantModelProviderAccess,
} from '~/api/model-providers';
import { Pager, createOffsetPages } from '~/components/pager';
import { SearchInput } from '~/components/store/store-list';
import { Building2, Users } from '~/components/icons';
import { Button } from '~/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '~/components/ui/dialog';
import { cn } from '~/lib/cn';
import { TIPS } from './copy';
import { InfoTip } from './provider-widgets';

const DIALOG_PAGE_SIZE = 8;

type Shown = 'all' | 'withheld';

function isWithheld(tenant: TenantModelProviderAccess, name: string): boolean {
  return tenant.withheld.includes(name);
}

function modeOf(access: PlatformModelProviderAccess | undefined, name: string): AvailabilityMode {
  return access?.providers.find((provider) => provider.name === name)?.mode ?? 'every';
}

function organizations(count: number): string {
  return count === 1 ? '1 organization' : `${count} organizations`;
}

function pillText(available: number, total: number, mode: AvailabilityMode): string {
  if (mode === 'chosen') return `Available to ${available} chosen of ${organizations(total)}`;
  return available === total
    ? `Available to all ${organizations(total)}`
    : `Available to ${available} of ${total} organizations`;
}

export function OrganizationAccessPill(props: { name: string }) {
  const access = usePlatformModelProviderAccess();
  const [open, setOpen] = createSignal(false);
  const tenants = () => access.data?.tenants ?? [];
  const available = () => tenants().filter((tenant) => !isWithheld(tenant, props.name)).length;
  const mode = () => modeOf(access.data, props.name);
  const everyone = () => available() === tenants().length && mode() === 'every';

  return (
    <Show when={access.data}>
      <button
        type="button"
        class={cn(
          'mt-1 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          everyone() ? 'bg-muted text-muted-foreground' : 'bg-amber-500/15 text-amber-800'
        )}
        onClick={() => setOpen(true)}
      >
        <Users class="h-3 w-3" aria-hidden="true" />
        {pillText(available(), tenants().length, mode())}
      </button>
      <OrganizationAccessDialog name={props.name} open={open()} onOpenChange={setOpen} />
    </Show>
  );
}

export function OrganizationAccessDialog(props: {
  name: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const access = usePlatformModelProviderAccess();
  const setAccess = useSetModelProviderAccess();
  const [query, setQuery] = createSignal('');
  const [shown, setShown] = createSignal<Shown>('all');
  const [busy, setBusy] = createSignal(false);
  const [confirmingUntickAll, setConfirmingUntickAll] = createSignal(false);
  const tenants = () => access.data?.tenants ?? [];
  const filtered = createMemo(() => {
    const needle = query().trim().toLowerCase();
    return tenants().filter(
      (tenant) =>
        tenant.displayName.toLowerCase().includes(needle) && (shown() === 'all' || isWithheld(tenant, props.name))
    );
  });
  const pages = createOffsetPages(filtered, DIALOG_PAGE_SIZE);
  const withheldCount = () => tenants().filter((tenant) => isWithheld(tenant, props.name)).length;

  async function apply(targets: TenantModelProviderAccess[], withheld: boolean) {
    const changing = targets.filter((tenant) => isWithheld(tenant, props.name) !== withheld);
    if (changing.length === 0) return;
    setBusy(true);
    try {
      for (const tenant of changing) {
        await setAccess.mutateAsync({ name: props.name, tenantId: tenant.tenantId, withheld });
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'The access could not be changed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent class="max-w-lg" align="top">
        <DialogTitle>
          Who can use{' '}
          <span class="font-mono" translate="no">
            {props.name}
          </span>
        </DialogTitle>
        <DialogDescription>
          An unticked organization doesn’t see {props.name} and sends it nothing, and its admin can’t switch it back on.
          Ticking it again restores the organization’s own switch and weight.
        </DialogDescription>
        <div class="mt-3 space-y-2">
          <NewOrganizationsChoice name={props.name} mode={modeOf(access.data, props.name)} />
          <div class="flex flex-wrap items-center gap-2">
            <div class="min-w-48 flex-1">
              <SearchInput
                label="Search organizations"
                value={query()}
                onInput={(value) => {
                  setQuery(value);
                  pages.toFirst();
                }}
              />
            </div>
            <div role="group" aria-label="Organizations shown" class="inline-flex rounded-md bg-muted p-0.5 text-xs">
              <button
                type="button"
                aria-pressed={shown() === 'all'}
                class="rounded px-2 py-1 aria-pressed:bg-background aria-pressed:shadow-sm"
                onClick={() => {
                  setShown('all');
                  pages.toFirst();
                }}
              >
                All
              </button>
              <button
                type="button"
                aria-pressed={shown() === 'withheld'}
                class="rounded px-2 py-1 aria-pressed:bg-background aria-pressed:shadow-sm"
                onClick={() => {
                  setShown('withheld');
                  pages.toFirst();
                }}
              >
                Withheld ({withheldCount()})
              </button>
            </div>
          </div>
          <Show
            when={!confirmingUntickAll()}
            fallback={
              <div class="flex flex-wrap items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs">
                <span class="flex-1">
                  Withhold {props.name} from the {filtered().length} organizations shown? Their Agents stop using it at
                  once.
                </span>
                <Button size="sm" variant="ghost" class="h-7 text-xs" onClick={() => setConfirmingUntickAll(false)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  class="h-7 text-xs"
                  onClick={() => {
                    setConfirmingUntickAll(false);
                    void apply(filtered(), true);
                  }}
                >
                  Withhold
                </Button>
              </div>
            }
          >
            <div class="flex gap-3 text-xs">
              <button
                type="button"
                class="text-primary hover:underline disabled:opacity-50"
                disabled={busy()}
                onClick={() => void apply(filtered(), false)}
              >
                Tick all shown
              </button>
              <button
                type="button"
                class="text-primary hover:underline disabled:opacity-50"
                disabled={busy()}
                onClick={() => setConfirmingUntickAll(true)}
              >
                Untick all shown
              </button>
            </div>
          </Show>
          <ul class="divide-y divide-border rounded-md border border-border">
            <For
              each={pages.page()}
              fallback={<li class="px-3 py-4 text-center text-xs text-muted-foreground">No organizations</li>}
            >
              {(tenant) => (
                <li>
                  <label class="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm hover:bg-accent/40">
                    <input
                      type="checkbox"
                      class="h-3.5 w-3.5 accent-primary"
                      checked={!isWithheld(tenant, props.name)}
                      disabled={busy()}
                      onChange={(event) => void apply([tenant], !event.currentTarget.checked)}
                    />
                    <Building2 class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span class="min-w-0 flex-1 truncate" title={tenant.displayName}>
                      {tenant.displayName}
                    </span>
                    <Show when={isWithheld(tenant, props.name)}>
                      <span class="text-[11px] text-muted-foreground">Withheld</span>
                    </Show>
                  </label>
                </li>
              )}
            </For>
          </ul>
          <Show when={pages.needsPager()}>
            <Pager {...pages.pagerProps()} />
          </Show>
        </div>
        <div class="mt-4 flex justify-end">
          <Button size="sm" onClick={() => props.onOpenChange(false)}>
            Done
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const NEW_ORGANIZATIONS_LABEL: Record<AvailabilityMode, string> = {
  every: 'Get it automatically',
  chosen: 'Only once ticked here',
};

function NewOrganizationsChoice(props: { name: string; mode: AvailabilityMode }) {
  const setMode = useSetAvailabilityMode();

  function choose(mode: AvailabilityMode) {
    if (mode === props.mode) return;
    setMode.mutate(
      { name: props.name, mode },
      { onError: (err) => toast.error(err instanceof ApiError ? err.message : 'The setting could not be changed') }
    );
  }

  return (
    <div class="flex flex-wrap items-center gap-2 text-xs">
      <span class="text-muted-foreground">Organizations added later</span>
      <div role="group" aria-label="Organizations added later" class="inline-flex rounded-md bg-muted p-0.5">
        <For each={['every', 'chosen'] as const}>
          {(mode) => (
            <button
              type="button"
              aria-pressed={props.mode === mode}
              disabled={setMode.isPending}
              class="rounded px-2 py-1 aria-pressed:bg-background aria-pressed:shadow-sm disabled:opacity-50"
              onClick={() => choose(mode)}
            >
              {NEW_ORGANIZATIONS_LABEL[mode]}
            </button>
          )}
        </For>
      </div>
      <InfoTip content={TIPS.newOrganizations} label="What happens to organizations added later" />
    </div>
  );
}

export function ApplyToEveryOrganization() {
  const rewriteKeys = useRewriteEveryOrganizationsKeys();

  function apply() {
    rewriteKeys.mutate(undefined, {
      onSuccess: (result) => {
        if (result.failed.length === 0) {
          toast.success(`Model gateway keys of ${result.organizations} organizations follow these settings`);
          return;
        }
        toast.error(`${result.failed.map((tenant) => tenant.displayName).join(', ')} could not be updated; try again`);
      },
      onError: (err) => toast.error(err instanceof ApiError ? err.message : 'The keys could not be updated'),
    });
  }

  return (
    <div class="flex items-center gap-1.5">
      <Button
        variant="outline"
        size="sm"
        loading={rewriteKeys.isPending}
        disabled={rewriteKeys.isPending}
        onClick={apply}
      >
        Apply to every organization
      </Button>
      <InfoTip content={TIPS.applyToEveryOrganization} label="What Apply to every organization does" />
    </div>
  );
}
