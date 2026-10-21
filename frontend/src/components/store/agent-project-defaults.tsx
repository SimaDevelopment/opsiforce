import { Dynamic } from 'solid-js/web';
import type { Component, ParentProps } from 'solid-js';
import type { PodSettings } from '~/api/client';
import { Cpu, Layers } from '~/components/icons';
import { Tooltip, TooltipContent, TooltipTrigger } from '~/components/ui/tooltip';
import { cn } from '~/lib/cn';
import { formatCores, formatGib, podClassTitle } from '~/lib/pod-resources';

export function AgentProjectDefaults(props: {
  podSettings: PodSettings;
  readyProjects: number;
  imageOwned: boolean;
  onEdit?: () => void;
}) {
  const resourcesHint = () =>
    `Each new Project starts at ${formatCores(props.podSettings.cpuMillicores)}, ${formatGib(props.podSettings.memoryRequestMib)} memory, up to ${formatGib(props.podSettings.memoryLimitMib)}.`;
  const readyHint = () =>
    props.readyProjects === 0
      ? 'No Projects are kept ready, so a new Project takes a moment to start.'
      : `${props.readyProjects === 1 ? 'One Project is' : `${props.readyProjects} Projects are`} kept running, so a new Project opens instantly.`;
  const source = () => (props.imageOwned ? ' Set by the agent image.' : '');

  return (
    <div class="mt-2.5 flex flex-wrap items-center gap-1.5">
      <span class="mr-0.5 text-xs text-muted-foreground">New Projects</span>
      <DefaultChip icon={Cpu} hint={resourcesHint() + source()} onEdit={props.onEdit}>
        <span class="font-medium">{podClassTitle(props.podSettings.podClass)}</span>
        <span class="text-muted-foreground tabular-nums">
          {formatCores(props.podSettings.cpuMillicores)} · {formatGib(props.podSettings.memoryRequestMib)}
        </span>
      </DefaultChip>
      <DefaultChip icon={Layers} hint={readyHint() + source()} onEdit={props.onEdit} muted={props.readyProjects === 0}>
        <span class="font-medium tabular-nums">{props.readyProjects === 0 ? 'None' : props.readyProjects}</span>
        <span class="text-muted-foreground">ready</span>
      </DefaultChip>
    </div>
  );
}

function DefaultChip(
  props: ParentProps<{ icon: Component<{ class?: string }>; hint: string; onEdit?: () => void; muted?: boolean }>
) {
  return (
    <Tooltip>
      <TooltipTrigger
        as={props.onEdit ? 'button' : 'span'}
        type={props.onEdit ? 'button' : undefined}
        onClick={() => props.onEdit?.()}
        class={cn(
          'inline-flex h-6 items-center gap-1.5 rounded-md border border-border px-2 text-xs text-foreground',
          props.onEdit &&
            'transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          props.muted && 'text-muted-foreground'
        )}
      >
        <Dynamic component={props.icon} class="h-3.5 w-3.5 text-muted-foreground" />
        {props.children}
      </TooltipTrigger>
      <TooltipContent class="max-w-64">{props.hint}</TooltipContent>
    </Tooltip>
  );
}
