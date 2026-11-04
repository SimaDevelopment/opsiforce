import { For, Show, createEffect, createSignal, on, type Component } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { Link } from '@tanstack/solid-router';
import {
  needsAttention,
  useProjectExternalServices,
  type ProjectEnvironmentRef,
  type ProjectServiceSummary,
} from '~/api/project-external-services';
import { usePermissions } from '~/api/permissions';
import { ServiceIcon } from '~/components/external-service/service-marks';
import { OriginBadge } from '~/components/store/store-list';
import { InfoTip } from '~/components/ui/info-tip';
import { Popover, PopoverContent, PopoverTrigger } from '~/components/ui/popover';
import { AlertTriangle, Cable, ChevronDown, ChevronRight, CircleCheck, CircleDashed, Plug } from '~/components/icons';
import { cn } from '~/lib/cn';
import { ProjectConfigurationDialog } from './project-configuration-dialog';
import { STRIP_BUTTON_CLASS, STRIP_COUNT_CLASS } from '~/components/composer-strip';

type ServiceStatus = { label: string; icon: Component<{ class?: string }>; tone: string };

function serviceStatus(service: ProjectServiceSummary): ServiceStatus {
  if (service.state === 'needs-configuration') {
    return { label: 'Needs configuration', icon: CircleDashed, tone: 'of-ink of-tone-needs-you' };
  }
  if (service.state === 'available')
    return { label: 'Available · Click to enable', icon: Plug, tone: 'text-muted-foreground' };
  if (needsAttention(service.configuration)) {
    return { label: 'Needs attention', icon: AlertTriangle, tone: 'of-ink of-tone-needs-you' };
  }
  return { label: 'Connected', icon: CircleCheck, tone: 'of-ink of-tone-done' };
}

function ServiceRow(props: { service: ProjectServiceSummary; onOpen: () => void }) {
  const status = () => serviceStatus(props.service);
  return (
    <div class="relative flex items-center gap-2.5 px-3 py-2 transition-colors hover:bg-accent has-[button:focus-visible]:bg-accent">
      <ServiceIcon icon={props.service.icon} name={props.service.displayName} class="h-4 w-4" />
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            class="truncate text-left text-xs font-medium after:absolute after:inset-0 focus-visible:outline-none"
            onClick={() => props.onOpen()}
          >
            {props.service.displayName}
          </button>
          <span class="relative z-10 inline-flex items-center gap-1.5">
            <OriginBadge origin={props.service.origin} />
            <Show when={props.service.description}>
              {(description) => <InfoTip label={`About ${props.service.displayName}`}>{description()}</InfoTip>}
            </Show>
          </span>
        </div>
        <span class={cn('mt-0.5 flex items-center gap-1 text-[0.6875rem]', status().tone)}>
          <Dynamic component={status().icon} class="h-3 w-3 shrink-0" aria-hidden="true" />
          {status().label}
        </span>
      </div>
      <ChevronRight class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
    </div>
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
        <PopoverTrigger class={STRIP_BUTTON_CLASS} aria-label={`External services, ${names().length} connected`}>
          <Cable class="h-3.5 w-3.5" aria-hidden="true" />
          <span>External services</span>
          <span class={cn(STRIP_COUNT_CLASS, attentionCount() > 0 && 'of-tone of-tone-needs-you')}>
            <Show when={attentionCount() > 0}>
              <AlertTriangle class="h-3 w-3" aria-label="A configuration needs attention" />
            </Show>
            {names().length} connected
          </span>
          <ChevronDown class="h-3 w-3 opacity-60" aria-hidden="true" />
        </PopoverTrigger>
        <PopoverContent class="w-96" onOpenAutoFocus={(event) => event.preventDefault()}>
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
                class="block border-t border-border px-3 py-2 text-[0.6875rem] text-muted-foreground hover:text-foreground"
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
