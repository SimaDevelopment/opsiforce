import { For, Show, createEffect, createSignal, on } from 'solid-js';
import { Link } from '@tanstack/solid-router';
import {
  needsAttention,
  useProjectExternalServices,
  type ProjectEnvironmentRef,
  type ProjectServiceSummary,
} from '~/api/project-external-services';
import { usePermissions } from '~/api/permissions';
import { ServiceIcon } from '~/components/external-service/service-marks';
import { Popover, PopoverContent, PopoverTrigger } from '~/components/ui/popover';
import { AlertTriangle, Cable, ChevronDown, ChevronRight } from '~/components/icons';
import { cn } from '~/lib/cn';
import { ProjectConfigurationDialog } from './project-configuration-dialog';
import { STRIP_BUTTON_CLASS, STRIP_COUNT_CLASS } from '~/components/composer-strip';

function OriginMark(props: { origin: string }) {
  return (
    <span class="inline-flex shrink-0 items-center rounded border border-border px-1 py-px text-[10px] text-muted-foreground">
      {props.origin === 'built_in' ? 'Built-in' : 'Custom'}
    </span>
  );
}

function configurationSummary(service: ProjectServiceSummary): string {
  if (service.state === 'needs-configuration') return 'Needs configuration';
  if (service.state === 'available') return 'Available · Click to enable';
  return needsAttention(service.configuration) ? 'Needs attention' : 'Connected';
}

function ServiceRow(props: { service: ProjectServiceSummary; onOpen: () => void }) {
  return (
    <button
      type="button"
      class="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
      title={props.service.description}
      onClick={() => props.onOpen()}
    >
      <ServiceIcon icon={props.service.icon} name={props.service.displayName} class="h-4 w-4" />
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-1.5">
          <span class="truncate text-xs font-medium">{props.service.displayName}</span>
          <OriginMark origin={props.service.origin} />
        </div>
        <span
          class={cn(
            'flex flex-wrap items-center gap-x-1 text-[11px]',
            needsAttention(props.service.configuration) ? 'text-amber-700' : 'text-muted-foreground'
          )}
        >
          <Show when={needsAttention(props.service.configuration)}>
            <AlertTriangle class="h-3 w-3" aria-hidden="true" />
          </Show>
          <span>{configurationSummary(props.service)}</span>
        </span>
      </div>
      <ChevronRight class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
    </button>
  );
}

export function ExternalServicesButton(props: {
  projectId: string;
  projectEnvironmentId: string;
  environmentName: string;
}) {
  const { hasPermission } = usePermissions();
  const environment = (): ProjectEnvironmentRef => ({
    projectId: props.projectId,
    projectEnvironmentId: props.projectEnvironmentId,
  });
  const list = useProjectExternalServices(environment);
  const services = () => list.data?.services ?? [];
  const [popoverOpen, setPopoverOpen] = createSignal(false);
  const [openServiceId, setOpenServiceId] = createSignal<string | null>(null);
  const canManageAgents = () => hasPermission('can_manage_agents');
  const attentionCount = () => services().filter((service) => needsAttention(service.configuration)).length;
  const names = () =>
    services()
      .filter((service) => service.state === 'enabled')
      .map((service) => service.displayName);

  createEffect(
    on(
      () => props.projectEnvironmentId,
      () => {
        setPopoverOpen(false);
        setOpenServiceId(null);
      },
      { defer: true }
    )
  );

  return (
    <Show when={services().length > 0 || (canManageAgents() && list.data)}>
      <Popover placement="top-start" open={popoverOpen()} onOpenChange={setPopoverOpen}>
        <PopoverTrigger
          class={STRIP_BUTTON_CLASS}
          aria-label={`External services, ${names().length} connected`}
          title={names().length > 0 ? `Connected: ${names().join(', ')}` : 'No External Services connected'}
        >
          <Cable class="h-3.5 w-3.5" aria-hidden="true" />
          <span>External services</span>
          <span class={cn(STRIP_COUNT_CLASS, attentionCount() > 0 && 'bg-amber-100 text-amber-800')}>
            <Show when={attentionCount() > 0}>
              <AlertTriangle class="h-3 w-3" aria-label="A configuration needs attention" />
            </Show>
            {names().length} connected
          </span>
          <ChevronDown class="h-3 w-3 opacity-60" aria-hidden="true" />
        </PopoverTrigger>
        <PopoverContent class="w-96">
          <div class="border-b border-border px-3 py-2 text-[11px] font-medium text-muted-foreground">
            External services for {props.environmentName}
          </div>
          <div class="max-h-[50vh] divide-y divide-border overflow-y-auto">
            <For
              each={services()}
              fallback={
                <p class="px-3 py-3 text-xs text-muted-foreground">
                  No External Services are available to this Organization.
                </p>
              }
            >
              {(service) => (
                <ServiceRow
                  service={service}
                  onOpen={() => {
                    setPopoverOpen(false);
                    setOpenServiceId(service.id);
                  }}
                />
              )}
            </For>
          </div>
          <Show when={canManageAgents() && list.data?.agentId}>
            {(agentId) => (
              <Link
                to="/store/agents/$id"
                params={{ id: agentId() }}
                class="block border-t border-border px-3 py-2 text-[11px] text-muted-foreground hover:text-foreground"
              >
                Give this agent a service's skill for every Project: on the Agent →
              </Link>
            )}
          </Show>
        </PopoverContent>
      </Popover>
      <ProjectConfigurationDialog
        environment={environment()}
        environmentName={props.environmentName}
        serviceId={openServiceId()}
        onClose={() => setOpenServiceId(null)}
      />
    </Show>
  );
}
