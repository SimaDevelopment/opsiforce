import { For, Show, createMemo, createSignal, untrack, type JSX } from 'solid-js';
import { toast } from 'solid-sonner';
import { useNavigate } from '@tanstack/solid-router';
import type { ServiceManifest } from '@opsiforce/external-service-sdk/forms';
import { useEnvironments, type Environment } from '~/api/environments';
import {
  useEnvironmentManifests,
  type EnvironmentManifest,
  type ManifestChange,
  type ManifestDiff,
} from '~/api/external-service-publishing';
import { builderPath } from '~/api/builder';
import { ApiError } from '~/api/client';
import {
  callServiceForm,
  isCustomServiceView,
  isUncallableCustomServiceView,
  useOperatorService,
  useTenantService,
  useDiscardServiceConfigurationHook,
  useRetryServiceConfigurationHook,
  useRotateServiceConfiguration,
  useSaveServiceConfiguration,
  useSwitchCustomService,
  type DefaultEnvironment,
  type ExternalServiceSummary,
  type OperatorServiceView,
  type SdkStatus,
} from '~/api/external-service-views';
import { callLogSources, type ServiceCopy } from '~/api/external-service-call-log';
import { usePermissions } from '~/api/permissions';
import { ActionsMenu, ActionsMenuItem } from '~/components/actions-menu';
import { CallLog } from '~/components/external-service/call-log';
import { ConnectedProjects } from '~/components/external-service/connected-projects';
import { ServiceUsage } from '~/components/external-service/service-usage';
import { PublishServiceDialog } from '~/components/external-service/publish-service-dialog';
import { DuplicateServiceDialog, ExportServiceDialog } from '~/components/external-service/service-copy-dialogs';
import { SdkBadge } from '~/components/external-service/sdk-badge';
import { canManageExternalService, canSeeExternalServices } from '~/components/external-service/service-access';
import { DeleteServiceDialog, DisableServiceDialog } from '~/components/external-service/service-lifecycle-dialogs';
import { ChangeMark, NeedsSetupBadge, ServiceIcon } from '~/components/external-service/service-marks';
import {
  ConfigurationFooter,
  createConfigurationEdits,
  useConfigurationForm,
  type ConfigurationEdits,
} from '~/components/external-service-form/configuration-form';
import { ReadOnlyNotice, ServiceFormFields } from '~/components/external-service-form/form-renderer';
import type { FormContext } from '~/components/external-service-form/form-context';
import { storedOrDefaults } from '~/components/external-service-form/form-values';
import { HookFailureNotice } from '~/components/external-service-form/save-notices';
import { EnvironmentList, EnvironmentSplit, type EnvironmentRowStatus } from '~/components/store/environment-list';
import { StorePageHeader } from '~/components/store/store-page';
import {
  DisabledBadge,
  EmptyState,
  ErrorState,
  FilterChips,
  OriginBadge,
  RowList,
  SectionTitle,
} from '~/components/store/store-list';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '~/components/ui/tabs';
import {
  AlertTriangle,
  Ban,
  Cable,
  CirclePlay,
  Copy,
  Download,
  Files,
  Pencil,
  Rocket,
  Trash2,
} from '~/components/icons';
import { Badge } from '~/components/ui/badge';
import { cn } from '~/lib/cn';
import { createDocumentTitle } from '~/lib/create-document-title';

export const EXTERNAL_SERVICE_TABS = ['overview', 'configuration', 'calls', 'usage'] as const;

export type ExternalServiceTab = (typeof EXTERNAL_SERVICE_TABS)[number];

const TAB_LABELS: Record<ExternalServiceTab, string> = {
  overview: 'Overview',
  configuration: 'Service configuration',
  calls: 'Calls',
  usage: 'Usage',
};

interface ServicePageModel extends ExternalServiceSummary {
  manifest: Omit<ServiceManifest, 'serviceForm'>;
  fullManifest: ServiceManifest | null;
  serviceSkill: string | null;
  operator: OperatorServiceView | null;
  builderChatId: string | null;
  hidesBuiltIn: boolean;
  disabled: boolean;
  published: boolean;
  sdk: SdkStatus | null;
  defaultEnvironment: DefaultEnvironment | null;
  builtOnSdk1: boolean;
}

const BUILT_IN_PAGE = { published: true, sdk: null, defaultEnvironment: null, builtOnSdk1: false } as const;

const UNWRITTEN_SKILL_PLACEHOLDER = 'Say what the upstream system is and when an Agent should reach for this service';

function withoutServiceForm(manifest: ServiceManifest): Omit<ServiceManifest, 'serviceForm'> {
  const { serviceForm: _serviceForm, ...rest } = manifest;
  return rest;
}

function unreadableManifest(service: ExternalServiceSummary): Omit<ServiceManifest, 'serviceForm'> {
  return { displayName: service.displayName, description: service.description } as Omit<ServiceManifest, 'serviceForm'>;
}

function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

function downloadManifest(slug: string, manifest: ServiceManifest) {
  const blob = new Blob([`${JSON.stringify(manifest, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${slug}.service.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function ExternalServicePage(props: {
  serviceId: string;
  tab: string | undefined;
  env: string | undefined;
  onTab: (tab: ExternalServiceTab) => void;
  onEnv: (environmentId: string) => void;
}) {
  const { permissions, hasPermission } = usePermissions();
  const isOperator = () => canManageExternalService('built_in', hasPermission);
  const isTenantAdmin = () => canManageExternalService('custom', hasPermission);
  const operatorView = useOperatorService(() => props.serviceId, isOperator);
  const tenantView = useTenantService(() => props.serviceId, isTenantAdmin);

  const model = createMemo((): ServicePageModel | undefined => {
    const operator = operatorView.data;
    if (operator) {
      return {
        ...operator,
        ...BUILT_IN_PAGE,
        manifest: withoutServiceForm(operator.manifest),
        fullManifest: operator.manifest,
        operator,
        builderChatId: null,
        hidesBuiltIn: false,
        disabled: false,
      };
    }
    const view = tenantView.data;
    if (!view) return undefined;
    if (isCustomServiceView(view)) {
      return {
        ...view,
        manifest: withoutServiceForm(view.manifest),
        fullManifest: view.manifest,
        operator: view,
        builtOnSdk1: false,
      };
    }
    if (isUncallableCustomServiceView(view)) {
      return {
        ...view,
        manifest: view.manifest ? withoutServiceForm(view.manifest) : unreadableManifest(view),
        fullManifest: view.manifest,
        operator: null,
      };
    }
    return {
      ...view,
      ...BUILT_IN_PAGE,
      fullManifest: null,
      operator: null,
      builderChatId: null,
      hidesBuiltIn: false,
      disabled: false,
    };
  });

  const missingFor = (asked: boolean, query: { data: unknown; error: unknown }) =>
    !asked || (query.data === undefined && isNotFound(query.error));
  const notFound = () =>
    model() === undefined && missingFor(isOperator(), operatorView) && missingFor(isTenantAdmin(), tenantView);
  const failed = () =>
    model() === undefined &&
    !notFound() &&
    [operatorView, tenantView].some((query) => query.isError && !isNotFound(query.error));
  const allowed = () => permissions.data === undefined || canSeeExternalServices(hasPermission);
  createDocumentTitle(() => model()?.displayName);

  return (
    <div class="h-full overflow-y-auto bg-background">
      <div class="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-8">
        <Show
          when={allowed()}
          fallback={
            <EmptyState
              icon={Cable}
              title="External Services are managed by platform operators and Organization admins."
            />
          }
        >
          <Show
            when={!notFound()}
            fallback={
              <EmptyState
                icon={Cable}
                title="This External Service isn't available."
                hint="It may need setup by a platform operator, or it no longer exists."
              />
            }
          >
            <Show when={!failed()} fallback={<ErrorState message="This External Service could not be loaded." />}>
              <Show
                when={model()}
                fallback={
                  <div class="flex justify-center py-10">
                    <Spinner />
                  </div>
                }
              >
                {(service) => (
                  <ServiceBody
                    service={service()}
                    canManage={canManageExternalService(service().origin, hasPermission)}
                    canReadUsage={isTenantAdmin()}
                    tab={props.tab}
                    env={props.env}
                    onTab={props.onTab}
                    onEnv={props.onEnv}
                  />
                )}
              </Show>
            </Show>
          </Show>
        </Show>
      </div>
    </div>
  );
}

function ServiceBody(props: {
  service: ServicePageModel;
  canManage: boolean;
  canReadUsage: boolean;
  tab: string | undefined;
  env: string | undefined;
  onTab: (tab: ExternalServiceTab) => void;
  onEnv: (environmentId: string) => void;
}) {
  const editable = () => (props.canManage ? props.service.operator : null);
  const builtInCallLog = () => props.service.origin === 'built_in';
  const canReadCalls = () => (builtInCallLog() ? props.canReadUsage : props.canManage);
  const tabs = (): ExternalServiceTab[] =>
    EXTERNAL_SERVICE_TABS.filter((tab) => {
      if (props.service.builtOnSdk1) return tab === 'overview';
      if (tab === 'configuration') return editable() !== null;
      if (tab === 'calls') return canReadCalls();
      if (tab === 'usage') return props.canReadUsage;
      return true;
    });
  const tab = (): ExternalServiceTab => tabs().find((candidate) => candidate === props.tab) ?? 'overview';

  return (
    <>
      <ServiceHeader service={props.service} editable={editable()} canManage={props.canManage} />
      <Tabs value={tab()} onChange={(next) => props.onTab(next as ExternalServiceTab)}>
        <TabsList class="w-fit justify-start">
          <For each={tabs()}>{(key) => <TabsTrigger value={key}>{TAB_LABELS[key]}</TabsTrigger>}</For>
        </TabsList>
        <TabsContent value="overview" class="mt-6">
          <OverviewTab
            service={props.service}
            editable={editable()}
            canManage={props.canManage}
            env={props.env}
            onEnv={props.onEnv}
            onOpenConfiguration={() => props.onTab('configuration')}
          />
        </TabsContent>
        <Show when={editable()}>
          {(view) => (
            <TabsContent value="configuration" class="mt-6">
              <ServiceConfigurationTab view={view()} />
            </TabsContent>
          )}
        </Show>
        <Show when={canReadCalls()}>
          <TabsContent value="calls" class="mt-6">
            <ServiceCallLog serviceId={props.service.id} showCopy={!builtInCallLog()} />
          </TabsContent>
        </Show>
        <Show when={props.canReadUsage}>
          <TabsContent value="usage" class="mt-6">
            <ServiceUsage serviceId={props.service.id} showCopy={props.service.origin === 'custom'} />
          </TabsContent>
        </Show>
      </Tabs>
    </>
  );
}

const COPY_OPTIONS: { id: ServiceCopy; label: string }[] = [
  { id: 'default', label: 'Default' },
  { id: 'development', label: 'Development' },
];

function ServiceCallLog(props: { serviceId: string; showCopy: boolean }) {
  const [copy, setCopy] = createSignal<ServiceCopy>('default');
  return (
    <CallLog
      source={callLogSources.tenantService(props.serviceId, copy())}
      showProject
      toolbar={
        props.showCopy ? (
          <FilterChips label="Copy of the service" options={COPY_OPTIONS} value={copy()} onChange={setCopy} />
        ) : undefined
      }
    />
  );
}

function ServiceHeader(props: { service: ServicePageModel; editable: OperatorServiceView | null; canManage: boolean }) {
  const navigate = useNavigate();
  const webhookUrl = () => (props.service.manifest.inbound ? props.editable?.webhookUrl : null);
  const custom = () => (props.service.builderChatId !== null && props.canManage ? props.service : null);
  const switchService = useSwitchCustomService(() => props.service.id);
  const [disableOpen, setDisableOpen] = createSignal(false);
  const [deleteOpen, setDeleteOpen] = createSignal(false);
  const [publishOpen, setPublishOpen] = createSignal(false);
  const [duplicateOpen, setDuplicateOpen] = createSignal(false);
  const [exportOpen, setExportOpen] = createSignal(false);
  const canAct = () => props.editable !== null || custom() !== null;
  return (
    <>
      <Show when={custom()}>
        {(service) => (
          <>
            <DisableServiceDialog service={service()} open={disableOpen()} onOpenChange={setDisableOpen} />
            <DeleteServiceDialog service={service()} open={deleteOpen()} onOpenChange={setDeleteOpen} />
            <PublishServiceDialog
              serviceId={service().id}
              displayName={service().displayName}
              open={publishOpen()}
              onOpenChange={setPublishOpen}
            />
            <Show when={duplicateOpen()}>
              <DuplicateServiceDialog service={service()} open onOpenChange={setDuplicateOpen} />
            </Show>
            <Show when={exportOpen()}>
              <ExportServiceDialog service={service()} open onOpenChange={setExportOpen} />
            </Show>
          </>
        )}
      </Show>
      <StorePageHeader
        backTo="/store/external-services"
        backLabel="External Services"
        title={
          <span class="inline-flex items-center gap-2">
            <ServiceIcon icon={props.service.icon} name={props.service.displayName} />
            {props.service.displayName}
          </span>
        }
        badges={
          <>
            <OriginBadge origin={props.service.origin} />
            <Show when={props.service.defaultEnvironment}>
              {(environment) => (
                <Badge variant="success" class="font-medium">
                  {environment().name} · default
                </Badge>
              )}
            </Show>
            <Show when={props.service.sdk}>{(sdk) => <SdkBadge sdk={sdk()} />}</Show>
            <Show when={props.service.disabled}>
              <DisabledBadge />
            </Show>
            <Show when={props.service.operator && !props.service.operator.available}>
              <NeedsSetupBadge />
            </Show>
          </>
        }
        description={props.service.description}
        meta={<span class="font-mono">{props.service.slug}</span>}
        actions={
          <Show when={canAct()}>
            <div class="flex items-center gap-2">
              <Show when={custom()}>
                {(service) => (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void navigate({ to: builderPath({ type: 'external_service', id: service().id }) })}
                    >
                      <Pencil class="h-3.5 w-3.5" aria-hidden="true" />
                      Edit in Builder
                    </Button>
                    <Show when={!service().builtOnSdk1}>
                      <Button size="sm" onClick={() => setPublishOpen(true)}>
                        <Rocket class="h-3.5 w-3.5" aria-hidden="true" />
                        Publish
                      </Button>
                    </Show>
                  </>
                )}
              </Show>
              <ActionsMenu label="External Service actions" variant="outline">
                <Show when={webhookUrl()}>
                  {(url) => (
                    <ActionsMenuItem icon={Copy} onSelect={() => void navigator.clipboard?.writeText(url())}>
                      Copy webhook URL
                    </ActionsMenuItem>
                  )}
                </Show>
                <Show when={props.service.fullManifest}>
                  {(manifest) => (
                    <ActionsMenuItem icon={Download} onSelect={() => downloadManifest(props.service.slug, manifest())}>
                      Download service.json
                    </ActionsMenuItem>
                  )}
                </Show>
                <Show when={custom()}>
                  <ActionsMenuItem icon={Files} onSelect={() => setDuplicateOpen(true)}>
                    Duplicate
                  </ActionsMenuItem>
                  <ActionsMenuItem icon={Download} onSelect={() => setExportOpen(true)}>
                    Export
                  </ActionsMenuItem>
                  <Show
                    when={props.service.disabled}
                    fallback={
                      <ActionsMenuItem icon={Ban} onSelect={() => setDisableOpen(true)}>
                        Disable
                      </ActionsMenuItem>
                    }
                  >
                    <ActionsMenuItem icon={CirclePlay} onSelect={() => switchService.mutate('enable')}>
                      Enable
                    </ActionsMenuItem>
                  </Show>
                  <ActionsMenuItem icon={Trash2} destructive onSelect={() => setDeleteOpen(true)}>
                    Delete
                  </ActionsMenuItem>
                </Show>
              </ActionsMenu>
            </div>
          </Show>
        }
      />
    </>
  );
}

type ShownManifest = Omit<ServiceManifest, 'serviceForm'>;

interface ManifestShown {
  manifest: ShownManifest | null;
  callers: ShownManifest | null;
  changes: ManifestDiff | null;
  environmentName: string | null;
}

interface ListedItem<T> {
  key: string;
  item: T;
  change: ManifestChange | null;
  aspects: ManifestDiff['events'][number]['aspects'];
}

const ENVIRONMENT_STATUS_TEXT: Record<EnvironmentManifest['status'], EnvironmentRowStatus> = {
  development: { text: 'Where you edit', stale: false },
  'same-as-development': { text: 'Same as Development', stale: false },
  'development-differs': { text: 'Development differs', stale: true },
  unpublished: { text: 'Not published yet', stale: false },
};

function listedItems<T>(
  current: Record<string, T>,
  callers: Record<string, T>,
  changes: { key: string; change: ManifestChange; aspects: ListedItem<T>['aspects'] }[] | null
): ListedItem<T>[] {
  const changeOf = new Map((changes ?? []).map((entry) => [entry.key, entry]));
  const present = Object.entries(current).map(([key, item]) => ({
    key,
    item,
    change: changeOf.get(key)?.change ?? null,
    aspects: changeOf.get(key)?.aspects ?? [],
  }));
  const removed = (changes ?? [])
    .filter((entry) => entry.change === 'removed' && callers[entry.key] !== undefined)
    .map((entry) => ({
      key: entry.key,
      item: callers[entry.key] as T,
      change: 'removed' as const,
      aspects: [],
    }));
  return [...present, ...removed];
}

function OverviewTab(props: {
  service: ServicePageModel;
  editable: OperatorServiceView | null;
  canManage: boolean;
  env: string | undefined;
  onEnv: (environmentId: string) => void;
  onOpenConfiguration: () => void;
}) {
  const perEnvironment = () => props.service.builderChatId !== null && props.canManage;
  const registry = useEnvironments({ enabled: perEnvironment });
  const manifests = useEnvironmentManifests(() => props.service.id, perEnvironment);

  const entryOf = (environmentId: string) => manifests.data?.find((entry) => entry.environmentId === environmentId);
  const callersEntry = () => manifests.data?.find((entry) => entry.serviceDefault);
  const selectedId = () => {
    const environments = registry.data ?? [];
    if (environments.some((environment) => environment.id === props.env)) return props.env ?? '';
    return callersEntry()?.environmentId ?? environments.find((environment) => environment.isDefault)?.id ?? '';
  };
  const shown = (): ManifestShown => {
    const entry = entryOf(selectedId());
    if (!entry) {
      return {
        manifest: props.service.manifest,
        callers: null,
        changes: null,
        environmentName: null,
      };
    }
    return {
      manifest: entry.manifest,
      callers: callersEntry()?.manifest ?? null,
      changes: entry.changes,
      environmentName: entry.name,
    };
  };
  const statusOf = (environment: Environment): EnvironmentRowStatus => {
    const entry = entryOf(environment.id);
    return entry ? ENVIRONMENT_STATUS_TEXT[entry.status] : { text: '', stale: false };
  };

  const Content = () => (
    <Show when={!props.service.builtOnSdk1} fallback={<BuiltOnSdk1Notice />}>
      <ServiceOverview />
    </Show>
  );

  const ServiceOverview = () => (
    <div class="flex min-w-0 flex-col gap-8">
      <Show when={props.service.hidesBuiltIn}>
        <div class="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50/60 p-4">
          <AlertTriangle class="mt-0.5 h-4 w-4 shrink-0 text-amber-700" aria-hidden="true" />
          <p class="flex-1 text-xs text-amber-900">
            A built-in service called <span class="font-mono">{props.service.slug}</span> was added to the platform
            after this one. It stays hidden in your Organization, so your agents and Apps keep reaching this service.
          </p>
        </div>
      </Show>
      <Show when={props.editable && !props.editable.available}>
        <div class="flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50/60 p-4 sm:flex-row sm:items-center">
          <AlertTriangle class="h-4 w-4 shrink-0 text-amber-700" aria-hidden="true" />
          <p class="flex-1 text-xs text-amber-900">
            {props.service.origin === 'custom'
              ? "Your Projects can't use this service until every required field of its Service configuration is filled."
              : "Organizations can't see or use this service until every required field of its Service configuration is filled."}
          </p>
          <Button size="sm" variant="outline" onClick={() => props.onOpenConfiguration()}>
            Open Service configuration
          </Button>
        </div>
      </Show>
      <Show when={!props.editable && props.service.builderChatId === null}>
        <ReadOnlyNotice>
          View only. Platform operators configure built-in services; your Organization's Projects can use this one.
        </ReadOnlyNotice>
      </Show>

      <Show
        when={shown().manifest}
        fallback={
          <EmptyState
            icon={Rocket}
            title={`Nothing published to ${shown().environmentName ?? 'this environment'} yet.`}
            hint="Publish, at the top of the page, copies Development here."
          />
        }
      >
        {(manifest) => <ManifestLists manifest={manifest()} shown={shown()} />}
      </Show>

      <Show when={props.canManage && props.service.origin === 'custom'}>
        <ConnectedProjects serviceId={props.service.id} serviceName={props.service.displayName} />
      </Show>

      <section>
        <SectionTitle>What the agent reads</SectionTitle>
        <Show
          when={props.service.serviceSkill}
          fallback={
            <p class="text-xs text-muted-foreground">
              This service has no Service skill of its own. Agents get a short one written from its name and
              description.
            </p>
          }
        >
          {(skill) => (
            <>
              <Show when={skill().includes(UNWRITTEN_SKILL_PLACEHOLDER)}>
                <p class="mb-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                  The builder hasn't written this service's skill yet. This is the starting placeholder, and Agents
                  connected to this service read it until the builder replaces it.
                </p>
              </Show>
              <pre class="max-h-96 overflow-auto whitespace-pre-wrap rounded-xl border border-border bg-card p-4 font-mono text-[11px] leading-relaxed">
                {skill()}
              </pre>
            </>
          )}
        </Show>
      </section>
    </div>
  );

  return (
    <Show when={perEnvironment() && registry.data} fallback={<Content />}>
      {(environments) => (
        <EnvironmentSplit
          list={
            <EnvironmentList
              environments={environments()}
              selectedId={selectedId()}
              defaultEnvironmentId={callersEntry()?.environmentId ?? null}
              defaultExplanation={`Callers reach ${callersEntry()?.name ?? 'this environment'}.`}
              statusOf={statusOf}
              onEnv={props.onEnv}
            />
          }
        >
          <Content />
        </EnvironmentSplit>
      )}
    </Show>
  );
}

function BuiltOnSdk1Notice() {
  return (
    <div class="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50/60 p-4">
      <AlertTriangle class="mt-0.5 h-4 w-4 shrink-0 text-amber-700" aria-hidden="true" />
      <p class="flex-1 text-xs text-amber-900">
        Built on SDK 1, rebuild or delete. Opsiforce no longer serves SDK 1 services: rebuild this one on SDK 2 in the
        Builder, or delete it.
      </p>
    </div>
  );
}

function ManifestLists(props: { manifest: ShownManifest; shown: ManifestShown }) {
  const events = () =>
    listedItems(
      props.manifest.events ?? {},
      props.shown.callers?.events ?? {},
      props.shown.changes?.events.map((entry) => ({ ...entry, key: entry.type })) ?? null
    );

  return (
    <>
      <section>
        <SectionTitle>Events</SectionTitle>
        <Show
          when={events().length > 0}
          fallback={<p class="text-xs text-muted-foreground">No Events. This service doesn't receive webhooks.</p>}
        >
          <RowList>
            <For each={events()}>
              {(listed) => (
                <ManifestRow
                  listed={listed}
                  kind={
                    <span class="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Event</span>
                  }
                  title={listed.item.title}
                  description={listed.item.description}
                />
              )}
            </For>
          </RowList>
        </Show>
      </section>
    </>
  );
}

function ManifestRow<T>(props: {
  listed: ListedItem<T>;
  kind: JSX.Element;
  title: string | undefined;
  description: string;
}) {
  const removed = () => props.listed.change === 'removed';
  return (
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
      <span
        class={cn('w-44 shrink-0 truncate font-mono text-xs', removed() && 'text-muted-foreground line-through')}
        title={props.listed.key}
      >
        {props.listed.key}
      </span>
      <span class={cn('flex w-24 shrink-0', removed() && 'opacity-60')}>{props.kind}</span>
      <span
        class={cn('w-44 shrink-0 truncate text-sm font-medium', removed() && 'text-muted-foreground line-through')}
        title={props.title}
      >
        {props.title}
      </span>
      <span class="min-w-48 flex-1 truncate text-xs text-muted-foreground" title={props.description}>
        {props.description}
      </span>
      <Show when={props.listed.change}>
        {(change) => (
          <span class="flex shrink-0 items-center gap-2">
            <ChangeMark change={change()} aspects={props.listed.aspects} />
          </span>
        )}
      </Show>
    </div>
  );
}

function ServiceConfigurationTab(props: { view: OperatorServiceView }) {
  const rotate = useRotateServiceConfiguration(
    () => props.view.id,
    () => props.view.origin
  );
  const retry = useRetryServiceConfigurationHook(
    () => props.view.id,
    () => props.view.origin
  );
  const discard = useDiscardServiceConfigurationHook(
    () => props.view.id,
    () => props.view.origin
  );
  const edits = createConfigurationEdits(
    untrack(() => props.view),
    {
      rotate: (target) => rotate.mutateAsync(target),
      retry: () => retry.mutateAsync(undefined),
      discard: () => discard.mutateAsync(undefined),
    }
  );

  return (
    <Show when={edits.base()} keyed>
      {(view) => <ServiceConfigurationEditor view={view} edits={edits} />}
    </Show>
  );
}

function ServiceConfigurationEditor(props: {
  view: OperatorServiceView;
  edits: ConfigurationEdits<OperatorServiceView>;
}) {
  const form = props.view.manifest.serviceForm ?? [];
  const stored = props.view.serviceConfiguration.values;
  const save = useSaveServiceConfiguration(
    () => props.view.id,
    () => props.view.origin
  );
  const configuration = useConfigurationForm({
    form,
    initial: storedOrDefaults(form, stored),
    missing: props.view.serviceConfiguration.missing,
    save,
    onEdit: props.edits.edited,
    onSaved: (next) => {
      props.edits.rebase(next);
      if (next.hookFailure) return;
      if (next.available) toast.success(`Saved the ${next.manifest.displayName} configuration`);
      else toast.warning('Saved, but the service still needs setup: some required fields are empty.');
    },
    saveFailedMessage: 'The Service configuration could not be saved.',
  });

  const ctx: FormContext = {
    draft: configuration.draft,
    readOnly: configuration.saving,
    templateValues: () => ({ webhookUrl: props.view.webhookUrl ?? '' }),
    serviceConfigurationOptions: () => [],
    storedLabel: configuration.labels.storedLabel,
    seenOptions: configuration.labels.seenOptions,
    callService: (route, name, request) =>
      callServiceForm(props.view, route, name, { values: configuration.draftValues(), ...request }),
    revealed: props.edits.revealed,
    rotate: props.edits.rotate,
  };

  return (
    <div class="rounded-xl border border-border bg-card p-5">
      <p class="mb-5 max-w-2xl text-xs text-muted-foreground">
        {props.view.origin === 'custom'
          ? 'One configuration for your Organization. Your Projects can use this service once every required field is filled.'
          : 'One configuration for the whole platform. Organizations can use this service once every required field is filled.'}{' '}
        Secrets are stored encrypted and never shown again.
      </p>
      <Show when={props.view.hookFailure}>
        {(hookFailure) => (
          <HookFailureNotice failure={hookFailure()} onRetry={props.edits.retry} onDiscard={props.edits.discard} />
        )}
      </Show>
      <Show
        when={form.length > 0}
        fallback={<p class="text-xs text-muted-foreground">This service has nothing to configure.</p>}
      >
        <form
          class="max-w-2xl"
          onSubmit={(event) => {
            event.preventDefault();
            void configuration.submit();
          }}
        >
          <ServiceFormFields fields={form} ctx={ctx} />
          <ConfigurationFooter
            saving={configuration.saving()}
            failure={configuration.failure()}
            hint={!props.edits.saved() && configuration.draft.isDirty() ? 'Unsaved changes' : null}
          />
        </form>
      </Show>
    </div>
  );
}
