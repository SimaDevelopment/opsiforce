import { For, Show, createEffect, createMemo, createSignal } from 'solid-js';
import { toast } from 'solid-sonner';
import { currentTenant } from '~/api/client';
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
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '~/components/ui/dialog';
import { cn } from '~/lib/cn';
import { TEXT_BUTTON_CLASS, errorMessage } from './connection-fields';
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

export function useWithoutAccessHere(enabled: () => boolean): (name: string) => boolean {
  const access = usePlatformModelProviderAccess(enabled);
  const here = () => access.data?.tenants.find((tenant) => tenant.name === currentTenant());
  return (name) => here()?.withheld.includes(name) ?? false;
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
  const setMode = useSetAvailabilityMode();
  const [query, setQuery] = createSignal('');
  const [shown, setShown] = createSignal<Shown>('all');
  const [drafted, setDrafted] = createSignal<Record<string, boolean>>({});
  const [draftedMode, setDraftedMode] = createSignal<AvailabilityMode | null>(null);
  const [saving, setSaving] = createSignal(false);
  const tenants = () => access.data?.tenants ?? [];
  const savedMode = () => modeOf(access.data, props.name);
  const mode = () => draftedMode() ?? savedMode();
  const hadAccess = (tenant: TenantModelProviderAccess) => !hasNoAccess(tenant, props.name);
  const hasAccess = (tenant: TenantModelProviderAccess) => drafted()[tenant.tenantId] ?? hadAccess(tenant);
  const changes = () => tenants().filter((tenant) => hasAccess(tenant) !== hadAccess(tenant));
  const losing = () => changes().filter((tenant) => !hasAccess(tenant)).length;
  const modeChanged = () => mode() !== savedMode();
  const changeCount = () => changes().length + (modeChanged() ? 1 : 0);
  const filtered = createMemo(() => {
    const needle = query().trim().toLowerCase();
    return tenants().filter(
      (tenant) =>
        tenant.displayName.toLowerCase().includes(needle) && (shown() === 'all' || hasNoAccess(tenant, props.name))
    );
  });
  const pages = createOffsetPages(filtered, DIALOG_PAGE_SIZE);
  const withoutCount = () => tenants().filter((tenant) => hasNoAccess(tenant, props.name)).length;

  createEffect(() => {
    if (props.open) {
      setDrafted({});
      setDraftedMode(null);
      setQuery('');
      setShown('all');
    }
  });

  function show(next: Shown) {
    setShown(next);
    pages.toFirst();
  }

  function draft(targets: TenantModelProviderAccess[], on: boolean) {
    setDrafted((current) => ({
      ...current,
      ...Object.fromEntries(targets.map((tenant) => [tenant.tenantId, on])),
    }));
  }

  async function save() {
    setSaving(true);
    let saved = 0;
    try {
      if (modeChanged()) {
        await setMode.mutateAsync({ name: props.name, mode: mode() });
        setDraftedMode(null);
        saved += 1;
      }
      for (const tenant of changes()) {
        await setAccess.mutateAsync({ name: props.name, tenantId: tenant.tenantId, withheld: !hasAccess(tenant) });
        setDrafted((current) => {
          const remaining = { ...current };
          delete remaining[tenant.tenantId];
          return remaining;
        });
        saved += 1;
      }
      toast.success(`Access to ${props.name} saved`);
      props.onOpenChange(false);
    } catch (err) {
      const message = errorMessage(err, 'The access could not be saved');
      toast.error(saved > 0 ? `${message}. The changes before it were saved.` : message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={(open) => !saving() && props.onOpenChange(open)}>
      <DialogContent class="max-w-lg" align="top">
        <DialogTitle>
          Who can use{' '}
          <span class="font-mono" translate="no">
            {props.name}
          </span>
        </DialogTitle>
        <DialogDescription>
          An organization without access doesn’t see <span translate="no">{props.name}</span> and sends it no requests.
          Giving access back restores the organization’s own switch and weight. Nothing changes until you save.
        </DialogDescription>
        <div class="mt-4 space-y-3">
          <LabelledSwitch
            checked={mode() === 'every'}
            disabled={saving()}
            onChange={(automatic) => setDraftedMode(automatic ? 'every' : 'chosen')}
            label="Give organizations added later access automatically"
            hint="Changing this doesn’t change the access of existing organizations."
          />
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
                    class="rounded px-2 py-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-sm"
                    onClick={() => show(option)}
                  >
                    {SHOWN_LABEL[option]}
                    <Show when={option === 'without'}>
                      {' '}
                      <span class="tabular-nums">({withoutCount()})</span>
                    </Show>
                  </button>
                )}
              </For>
            </div>
          </div>
          <div class="flex gap-3 text-xs">
            <button
              type="button"
              class={TEXT_BUTTON_CLASS}
              disabled={saving() || filtered().length === 0}
              onClick={() => draft(filtered(), true)}
            >
              Give access to all shown
            </button>
            <button
              type="button"
              class={TEXT_BUTTON_CLASS}
              disabled={saving() || filtered().length === 0}
              onClick={() => draft(filtered(), false)}
            >
              Remove access from all shown
            </button>
          </div>
          <ul class="divide-y divide-border rounded-md border border-border">
            <For
              each={pages.page()}
              fallback={<li class="px-3 py-4 text-center text-xs text-muted-foreground">No organizations</li>}
            >
              {(tenant) => {
                const changed = () => hasAccess(tenant) !== hadAccess(tenant);
                return (
                  <li class={cn('flex items-center gap-2 px-3 py-2 text-sm', changed() && 'bg-amber-500/5')}>
                    <Building2 class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span class="min-w-0 flex-1 truncate" title={tenant.displayName}>
                      {tenant.displayName}
                    </span>
                    <span
                      class={cn(
                        'inline-flex items-center gap-1 text-[11px]',
                        changed() ? 'font-medium text-amber-700' : 'text-muted-foreground'
                      )}
                    >
                      <Show when={changed()}>
                        <span class="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden="true" />
                      </Show>
                      {accessLabel(hasAccess(tenant), changed())}
                    </span>
                    <OnOffSwitch
                      checked={hasAccess(tenant)}
                      disabled={saving()}
                      label={`${tenant.displayName} has access`}
                      onChange={(on) => draft([tenant], on)}
                    />
                  </li>
                );
              }}
            </For>
          </ul>
          <Show when={pages.needsPager()}>
            <Pager {...pages.pagerProps()} />
          </Show>
          <Show when={losing() > 0}>
            <p class="text-xs text-amber-700">
              When you save, {organizations(losing())} {losing() === 1 ? 'loses' : 'lose'} access at once: their Agents
              and Apps stop using <span translate="no">{props.name}</span>.
            </p>
          </Show>
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" disabled={saving()} onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={changeCount() === 0} loading={saving()} onClick={() => void save()}>
            {changeCount() > 1 ? `Save ${changeCount()} changes` : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function accessLabel(hasAccess: boolean, changed: boolean): string {
  if (changed) return hasAccess ? 'Gets access on save' : 'Loses access on save';
  return hasAccess ? 'Has access' : 'No access';
}
