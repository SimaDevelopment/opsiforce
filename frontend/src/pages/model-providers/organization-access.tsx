import { For, Show, createMemo, createSignal } from 'solid-js';
import { toast } from 'solid-sonner';
import {
  usePlatformModelProviderAccess,
  useSetAvailabilityMode,
  useSetModelProviderAccess,
  type AvailabilityMode,
  type PlatformModelProviderAccess,
  type TenantModelProviderAccess,
} from '~/api/model-providers';
import { Pager, createOffsetPages } from '~/components/pager';
import { SearchInput } from '~/components/store/store-list';
import { Building2 } from '~/components/icons';
import { Button } from '~/components/ui/button';
import { ConfirmDialog } from '~/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '~/components/ui/dialog';
import { errorMessage } from './connection-fields';
import { LabelledSwitch, OnOffSwitch } from './provider-widgets';

const DIALOG_PAGE_SIZE = 8;

type Shown = 'all' | 'without';

function hasNoAccess(tenant: TenantModelProviderAccess, name: string): boolean {
  return tenant.withheld.includes(name);
}

function modeOf(access: PlatformModelProviderAccess | undefined, name: string): AvailabilityMode {
  return access?.providers.find((provider) => provider.name === name)?.mode ?? 'every';
}

function organizations(count: number): string {
  return count === 1 ? '1 organization' : `${count} organizations`;
}

const SHOWN_LABEL: Record<Shown, string> = {
  all: 'All',
  without: 'Without access',
};

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
  const [confirmingRemoveAll, setConfirmingRemoveAll] = createSignal(false);
  const tenants = () => access.data?.tenants ?? [];
  const filtered = createMemo(() => {
    const needle = query().trim().toLowerCase();
    return tenants().filter(
      (tenant) =>
        tenant.displayName.toLowerCase().includes(needle) && (shown() === 'all' || hasNoAccess(tenant, props.name))
    );
  });
  const pages = createOffsetPages(filtered, DIALOG_PAGE_SIZE);
  const withoutCount = () => tenants().filter((tenant) => hasNoAccess(tenant, props.name)).length;

  function show(next: Shown) {
    setShown(next);
    pages.toFirst();
  }

  async function apply(targets: TenantModelProviderAccess[], withheld: boolean) {
    const changing = targets.filter((tenant) => hasNoAccess(tenant, props.name) !== withheld);
    if (changing.length === 0) return;
    setBusy(true);
    try {
      for (const tenant of changing) {
        await setAccess.mutateAsync({ name: props.name, tenantId: tenant.tenantId, withheld });
      }
      const who = changing.length === 1 ? changing[0].displayName : organizations(changing.length);
      toast.success(
        withheld ? `${who} no longer has access to ${props.name}` : `${who} now has access to ${props.name}`
      );
    } catch (err) {
      toast.error(errorMessage(err, 'The access could not be changed'));
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
          An organization without access doesn’t see {props.name} and sends it no requests. Giving access back restores
          the organization’s own switch and weight.
        </DialogDescription>
        <div class="mt-4 space-y-3">
          <NewOrganizationsSwitch name={props.name} mode={modeOf(access.data, props.name)} />
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
              <For each={['all', 'without'] as const}>
                {(option) => (
                  <button
                    type="button"
                    aria-pressed={shown() === option}
                    class="rounded px-2 py-1 aria-pressed:bg-background aria-pressed:shadow-sm"
                    onClick={() => show(option)}
                  >
                    {SHOWN_LABEL[option]}
                    <Show when={option === 'without'}> ({withoutCount()})</Show>
                  </button>
                )}
              </For>
            </div>
          </div>
          <div class="flex gap-3 text-xs">
            <button
              type="button"
              class="text-primary hover:underline disabled:opacity-50"
              disabled={busy() || filtered().length === 0}
              onClick={() => void apply(filtered(), false)}
            >
              Give access to all shown
            </button>
            <button
              type="button"
              class="text-primary hover:underline disabled:opacity-50"
              disabled={busy() || filtered().length === 0}
              onClick={() => setConfirmingRemoveAll(true)}
            >
              Remove access from all shown
            </button>
          </div>
          <ul class="divide-y divide-border rounded-md border border-border">
            <For
              each={pages.page()}
              fallback={<li class="px-3 py-4 text-center text-xs text-muted-foreground">No organizations</li>}
            >
              {(tenant) => (
                <li class="flex items-center gap-2 px-3 py-2 text-sm">
                  <Building2 class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span class="min-w-0 flex-1 truncate" title={tenant.displayName}>
                    {tenant.displayName}
                  </span>
                  <span class="text-[11px] text-muted-foreground">
                    {hasNoAccess(tenant, props.name) ? 'No access' : 'Has access'}
                  </span>
                  <OnOffSwitch
                    checked={!hasNoAccess(tenant, props.name)}
                    disabled={busy()}
                    label={`${tenant.displayName} has access`}
                    onChange={(on) => void apply([tenant], !on)}
                  />
                </li>
              )}
            </For>
          </ul>
          <Show when={pages.needsPager()}>
            <Pager {...pages.pagerProps()} />
          </Show>
        </div>
        <DialogFooter>
          <Button size="sm" onClick={() => props.onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
        <ConfirmDialog
          open={confirmingRemoveAll()}
          onOpenChange={setConfirmingRemoveAll}
          title={`Remove access to ${props.name}`}
          description={`The ${organizations(filtered().length)} shown stop using ${props.name} at once, for Agents and Apps.`}
          confirmLabel="Remove access"
          variant="destructive"
          onConfirm={() => void apply(filtered(), true)}
        />
      </DialogContent>
    </Dialog>
  );
}

function NewOrganizationsSwitch(props: { name: string; mode: AvailabilityMode }) {
  const setMode = useSetAvailabilityMode();

  function change(automatic: boolean) {
    const mode: AvailabilityMode = automatic ? 'every' : 'chosen';
    if (mode === props.mode) return;
    setMode.mutate(
      { name: props.name, mode },
      {
        onSuccess: () =>
          toast.success(
            automatic
              ? `Organizations added later get access to ${props.name} automatically`
              : `Organizations added later get access to ${props.name} only when you give it`
          ),
        onError: (err) => toast.error(errorMessage(err, 'The setting could not be saved')),
      }
    );
  }

  return (
    <LabelledSwitch
      checked={props.mode === 'every'}
      disabled={setMode.isPending}
      onChange={change}
      label="Give organizations added later access automatically"
      hint="Changing this doesn’t change the access of existing organizations."
    />
  );
}
