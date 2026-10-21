import { For, Match, Show, Switch } from 'solid-js';
import { createStore } from 'solid-js/store';
import { useBlocker, useNavigate, useSearch } from '@tanstack/solid-router';
import {
  BASE_FORMAT_IDS,
  usePlatformModelProviders,
  useTenantModelProviders,
  type BaseFormatId,
  type PlatformModelProvider,
  type TenantModelProvider,
} from '~/api/model-providers';
import { usePermissions } from '~/api/permissions';
import { Permission } from '~/constants/permissions';
import { AlertTriangle, RefreshCw, Waypoints } from '~/components/icons';
import { SettingsSection } from '~/components/settings/settings-section';
import { Button } from '~/components/ui/button';
import { ConfirmDialog } from '~/components/ui/confirm-dialog';
import { Spinner } from '~/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';
import { BuiltInPlatformDetails, BuiltInPlatformPills, BuiltInRowMenu, builtInFormatOf } from './built-in-row';
import { TIPS } from './copy';
import {
  AUDIENCE_DESCRIPTION,
  AUDIENCE_LABEL,
  AUDIENCES,
  routingOf,
  splitRowOf,
  type Audience,
  type DirtyAudiences,
} from './audience';
import { BASE_FORMAT_LABEL, carriesTraffic } from './traffic-split';
import { FormatCard } from './format-card';
import { CustomProviderMenu, ReenterKeyButton } from './custom-provider-menu';
import { LinkedAccountSignIn, LinkedAccountStatus } from './linked-account-sign-in';
import { BuiltInPill, InfoTip, LabelWithTip, ProviderPill, StatusBadge, isCustomRow } from './provider-widgets';

interface Access {
  canSwitch: boolean;
  managesPlatform: boolean;
}

export function ModelProvidersPage() {
  const { hasPermission } = usePermissions();

  return (
    <SettingsSection
      icon={Waypoints}
      title="Model providers"
      description="Where this organization's model requests go. Each format splits its requests across the model providers that are on, by weight."
    >
      <Show
        when={
          hasPermission(Permission.manageTenantModelProviders) || hasPermission(Permission.managePlatformModelProviders)
        }
        fallback={
          <p class="text-sm text-muted-foreground">
            You don’t have permission to manage model providers. Ask an Organization admin for access.
          </p>
        }
      >
        <ModelProviderCards
          canSwitch={hasPermission(Permission.manageTenantModelProviders)}
          managesPlatform={hasPermission(Permission.managePlatformModelProviders)}
        />
      </Show>
    </SettingsSection>
  );
}

function ModelProviderCards(props: Access) {
  const tenantView = useTenantModelProviders(() => props.canSwitch);
  const platformView = usePlatformModelProviders(() => props.managesPlatform);
  const pending = () => (props.canSwitch && tenantView.isPending) || (props.managesPlatform && platformView.isPending);
  const failed = () => (props.canSwitch && tenantView.isError) || (props.managesPlatform && platformView.isError);
  const rows = () => (props.canSwitch ? (tenantView.data?.providers ?? []) : []);
  const builtIns = () => (props.managesPlatform ? (platformView.data?.providers ?? []) : []);
  const reachable = () =>
    props.canSwitch ? tenantView.data?.bifrostReachable === true : platformView.data?.bifrostReachable === true;
  const formats = (): BaseFormatId[] => tenantView.data?.baseFormats ?? [...BASE_FORMAT_IDS];
  const builtInsOf = (format: BaseFormatId | null) => builtIns().filter((row) => builtInFormatOf(row) === format);
  const missingBuiltIns = () => builtInsOf(null).filter((builtIn) => !rows().some((row) => row.name === builtIn.name));
  const search = useSearch({ from: '/settings/model-providers' });
  const navigate = useNavigate();
  const audience = (): Audience => (search().routing === 'apps' ? 'apps' : 'agents');
  const setAudience = (next: Audience) =>
    void navigate({
      to: '/settings/model-providers',
      search: (previous) => ({ ...previous, routing: next === 'apps' ? 'apps' : undefined }),
      replace: true,
    });
  const [dirtyFormats, setDirtyFormats] = createStore<Partial<Record<BaseFormatId, DirtyAudiences>>>({});
  const dirtyAudience = (target: Audience) => Object.values(dirtyFormats).some((dirty) => dirty?.[target]);
  const anyDirty = () => AUDIENCES.some(dirtyAudience);
  const reaches = (format: BaseFormatId, target: Audience) =>
    rows().some((row) => row.baseFormat === format && carriesTraffic(splitRowOf(row, routingOf(row), target)));
  const formatsAppsCantUse = () => formats().filter((format) => reaches(format, 'agents') && !reaches(format, 'apps'));

  function retry() {
    if (props.canSwitch) void tenantView.refetch();
    if (props.managesPlatform) void platformView.refetch();
  }

  return (
    <Switch>
      <Match when={pending()}>
        <output class="flex justify-center py-8">
          <Spinner label="Loading model providers…" />
        </output>
      </Match>
      <Match when={failed()}>
        <div role="alert" class="rounded-lg border border-dashed border-border py-10 text-center">
          <p class="text-sm font-medium text-foreground">The model providers could not be loaded</p>
          <p class="mt-1 text-xs text-muted-foreground">Check your connection, then try again.</p>
          <Button variant="outline" size="sm" class="mt-4" onClick={retry}>
            <RefreshCw class="h-3.5 w-3.5" />
            Try again
          </Button>
        </div>
      </Match>
      <Match when={!reachable()}>
        <UnreachableGateway rows={rows()} builtIns={props.canSwitch ? [] : builtIns()} canSwitch={props.canSwitch} />
      </Match>
      <Match when={true}>
        <div class="space-y-4">
          <Show when={props.canSwitch}>
            <AudienceSwitch
              value={audience()}
              onChange={setAudience}
              dirty={dirtyAudience}
              appsMissing={formatsAppsCantUse()}
            />
          </Show>
          <For each={formats()}>
            {(format) => (
              <FormatCard
                format={format}
                audience={audience()}
                rows={rows().filter((row) => row.baseFormat === format)}
                builtIns={builtInsOf(format)}
                canSwitch={props.canSwitch}
                managesPlatform={props.managesPlatform}
                onDirtyChange={(dirty) => setDirtyFormats(format, dirty)}
              />
            )}
          </For>
          <MissingProviders
            rows={rows().filter((row) => row.baseFormat === null)}
            builtIns={builtIns()}
            missingBuiltIns={missingBuiltIns()}
            canSwitch={props.canSwitch}
          />
          <UnsavedChangesGuard dirty={anyDirty} />
        </div>
      </Match>
    </Switch>
  );
}

function AudienceSwitch(props: {
  value: Audience;
  onChange: (audience: Audience) => void;
  dirty: (audience: Audience) => boolean;
  appsMissing: BaseFormatId[];
}) {
  return (
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <span id="routing-audience-label" class="text-xs font-medium text-foreground">
        Route requests from
      </span>
      <div
        role="group"
        aria-labelledby="routing-audience-label"
        class="inline-flex h-9 items-center rounded-lg bg-muted p-1 text-muted-foreground"
      >
        <For each={AUDIENCES}>
          {(audience) => (
            <button
              type="button"
              aria-pressed={props.value === audience}
              class="inline-flex h-7 items-center gap-1.5 rounded-md px-4 text-xs font-medium transition-[color,background-color,box-shadow] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-sm"
              onClick={() => props.onChange(audience)}
            >
              {AUDIENCE_LABEL[audience]}
              <Show when={audience === 'apps' && props.appsMissing.length > 0}>
                <AlertTriangle class="h-3 w-3 text-amber-600" aria-hidden="true" />
                <span class="sr-only">(no provider for some formats)</span>
              </Show>
              <Show when={props.dirty(audience)}>
                <span class="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden="true" />
                <span class="sr-only">(unsaved changes)</span>
              </Show>
            </button>
          )}
        </For>
      </div>
      <InfoTip content={TIPS.routing} label="How requests are split between model providers" />
      <p class="basis-full text-xs text-muted-foreground" aria-live="polite">
        {AUDIENCE_DESCRIPTION[props.value]} Saving a card saves its Agent and App routing together.
      </p>
      <Show when={props.appsMissing.length > 0}>
        <p class="basis-full text-xs text-amber-700 dark:text-amber-500">
          Apps can’t use {props.appsMissing.map((format) => BASE_FORMAT_LABEL[format]).join(' or ')} models: no model
          provider of that format is on for Apps.
          <Show when={props.value !== 'apps'}>
            {' '}
            <button
              type="button"
              class="font-medium underline underline-offset-4 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              onClick={() => props.onChange('apps')}
            >
              Choose providers for Apps
            </button>
          </Show>
        </p>
      </Show>
    </div>
  );
}

function UnsavedChangesGuard(props: { dirty: () => boolean }) {
  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) => props.dirty() && current.pathname !== next.pathname,
    enableBeforeUnload: () => props.dirty(),
    withResolver: true,
  });

  return (
    <ConfirmDialog
      open={blocker().status === 'blocked'}
      onOpenChange={(open) => !open && blocker().reset?.()}
      title="Leave without saving?"
      description="The weights and switches you changed here have not been saved. Leaving discards them."
      confirmLabel="Discard changes"
      cancelLabel="Keep editing"
      variant="destructive"
      onConfirm={() => blocker().proceed?.()}
    />
  );
}

function UnreachableGateway(props: {
  rows: TenantModelProvider[];
  builtIns: PlatformModelProvider[];
  canSwitch: boolean;
}) {
  return (
    <div class="space-y-4">
      <div class="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
        <AlertTriangle class="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          The model gateway can’t be reached, so statuses are Unknown and changes can’t be saved until it is back.
        </span>
      </div>
      <ReadOnlyProviders rows={props.rows} builtIns={[]} extraBuiltIns={props.builtIns} canSwitch={props.canSwitch} />
    </div>
  );
}

function MissingProviders(props: {
  rows: TenantModelProvider[];
  builtIns: PlatformModelProvider[];
  missingBuiltIns: PlatformModelProvider[];
  canSwitch: boolean;
}) {
  return (
    <Show when={props.rows.length > 0 || props.missingBuiltIns.length > 0}>
      <div class="space-y-3 rounded-lg border border-border p-4">
        <div>
          <h2 class="text-sm font-medium text-foreground">Not in the model gateway</h2>
          <p class="mt-0.5 text-xs text-muted-foreground">
            The gateway no longer has these model providers, so they get no requests until their key is re-entered.
          </p>
        </div>
        <ReadOnlyProviders
          rows={props.rows}
          builtIns={props.builtIns}
          extraBuiltIns={props.missingBuiltIns}
          canSwitch={props.canSwitch}
          actionable
        />
      </div>
    </Show>
  );
}

function ReadOnlyProviders(props: {
  rows: TenantModelProvider[];
  builtIns: PlatformModelProvider[];
  extraBuiltIns: PlatformModelProvider[];
  canSwitch: boolean;
  actionable?: boolean;
}) {
  const builtInOf = (name: string) => props.builtIns.find((builtIn) => builtIn.name === name);

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Model provider</TableHead>
          <TableHead>Status</TableHead>
          <Show when={props.canSwitch}>
            <TableHead class="w-20">
              <LabelWithTip label="Weight" tip={TIPS.weight} />
            </TableHead>
            <TableHead class="w-14">On</TableHead>
          </Show>
          <TableHead class={props.actionable ? 'w-40' : 'w-10'}>
            <span class="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <For each={props.rows}>
          {(row) => (
            <TableRow>
              <TableCell>
                <div class="flex flex-wrap items-center gap-1.5">
                  <span class="break-all font-mono text-xs font-medium" translate="no">
                    {row.name}
                  </span>
                  <ProviderPill row={row} />
                </div>
                <Show when={row.kind === 'linked-account'}>
                  <div class="mt-1.5">
                    <LinkedAccountSignIn scope="tenant" name={row.name} editable={props.actionable === true} linked />
                  </div>
                </Show>
              </TableCell>
              <TableCell>
                <Show when={row.kind === 'linked-account'} fallback={<StatusBadge status={row.status} />}>
                  <LinkedAccountStatus
                    scope="tenant"
                    name={row.name}
                    status={row.status}
                    editable={props.actionable === true}
                  />
                </Show>
              </TableCell>
              <TableCell class="text-xs tabular-nums">{row.chatWeight}</TableCell>
              <TableCell class="text-xs">{row.chatEnabled ? 'On' : 'Off'}</TableCell>
              <TableCell>
                <Show when={props.actionable}>
                  <Show
                    when={isCustomRow(row)}
                    fallback={<Show when={builtInOf(row.name)}>{(builtIn) => <BuiltInRowMenu row={builtIn()} />}</Show>}
                  >
                    <div class="flex items-center justify-end gap-1">
                      <Show when={row.kind !== 'linked-account'}>
                        <ReenterKeyButton name={row.name} />
                      </Show>
                      <CustomProviderMenu row={row} />
                    </div>
                  </Show>
                </Show>
              </TableCell>
            </TableRow>
          )}
        </For>
        <For each={props.extraBuiltIns}>
          {(builtIn) => (
            <TableRow>
              <TableCell>
                <div class="flex flex-wrap items-center gap-1.5">
                  <span class="break-all font-mono text-xs font-medium" translate="no">
                    {builtIn.name}
                  </span>
                  <BuiltInPill />
                  <BuiltInPlatformPills row={builtIn} />
                </div>
                <BuiltInPlatformDetails row={builtIn} editable={props.actionable === true} />
              </TableCell>
              <TableCell>
                <Show when={builtIn.linkedAccountVendor} fallback={<StatusBadge status={builtIn.status} />}>
                  <LinkedAccountStatus
                    scope="platform"
                    name={builtIn.name}
                    status={builtIn.status}
                    editable={props.actionable === true}
                  />
                </Show>
              </TableCell>
              <Show when={props.canSwitch}>
                <TableCell />
                <TableCell />
              </Show>
              <TableCell>
                <Show when={props.actionable}>
                  <BuiltInRowMenu row={builtIn} />
                </Show>
              </TableCell>
            </TableRow>
          )}
        </For>
      </TableBody>
    </Table>
  );
}
