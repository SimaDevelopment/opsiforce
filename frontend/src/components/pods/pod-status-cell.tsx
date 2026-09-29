import { Show } from 'solid-js';
import type { PodAgentUpdate, PodDbStatus, PodSkillDelivery, PodStatus } from '~/api/pods';
import { Tooltip, TooltipTrigger, TooltipContent } from '~/components/ui/tooltip';
import { AlertTriangle, RefreshCw } from '~/components/icons';
import { cn } from '~/lib/cn';

interface PodStatusCellProps {
  status: PodStatus;
  drift: boolean;
  dbStatus: PodDbStatus;
  skillDelivery: PodSkillDelivery;
  agentUpdate: PodAgentUpdate | null;
}

interface StatusVisual {
  dot: string;
  label: string;
  bad: boolean;
}

function statusVisual(status: PodStatus): StatusVisual {
  if (status.reason === 'CrashLoopBackOff') return { dot: 'bg-red-500', label: 'CrashLoopBackOff', bad: true };
  if (status.reason === 'ImagePullBackOff') return { dot: 'bg-red-500', label: 'Image pull error', bad: true };
  if (status.reason === 'Unschedulable') return { dot: 'bg-red-500', label: 'Unschedulable', bad: true };
  if (status.phase === 'terminating') return { dot: 'bg-orange-500', label: 'Terminating', bad: false };
  if (status.phase === 'running') {
    return status.ready
      ? { dot: 'bg-emerald-500', label: 'Running', bad: false }
      : { dot: 'bg-amber-500', label: 'Not ready', bad: false };
  }
  if (status.phase === 'pending') return { dot: 'bg-amber-500', label: 'Pending', bad: false };
  if (status.phase === 'failed') return { dot: 'bg-red-500', label: 'Failed', bad: true };
  if (status.phase === 'succeeded') return { dot: 'bg-muted-foreground', label: 'Completed', bad: false };
  return { dot: 'bg-muted-foreground', label: 'Unknown', bad: false };
}

function agentUpdateBad(status: PodAgentUpdate['status']): boolean {
  return status === 'failed' || status === 'conflict';
}

function agentUpdateLabel(status: PodAgentUpdate['status']): string {
  if (status === 'running') return 'updating';
  if (status === 'reload_pending') return 'awaiting restart';
  return status;
}

export function PodStatusCell(props: PodStatusCellProps) {
  const visual = () => statusVisual(props.status);

  return (
    <div class="flex items-center gap-2">
      <span class={cn('size-2 shrink-0 rounded-full', visual().dot)} />
      <span class={cn('text-xs', visual().bad ? 'font-medium text-red-600' : 'text-foreground')}>{visual().label}</span>

      <Show when={props.status.restartCount > 0}>
        <Tooltip>
          <TooltipTrigger
            as="span"
            class="inline-flex items-center gap-0.5 text-[11px] tabular-nums text-muted-foreground"
          >
            <RefreshCw class="size-3" />
            {props.status.restartCount}
          </TooltipTrigger>
          <TooltipContent>Container restarts</TooltipContent>
        </Tooltip>
      </Show>

      <Show when={!props.skillDelivery.converged}>
        <Tooltip>
          <TooltipTrigger
            as="span"
            class={cn(
              'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium',
              props.skillDelivery.failedAt === null
                ? 'border border-sky-200 bg-sky-50 text-sky-700'
                : 'border border-red-200 bg-red-50 text-red-700'
            )}
          >
            <AlertTriangle class="size-3" />
            Delivery {props.skillDelivery.failedAt === null ? 'pending' : 'failed'}
          </TooltipTrigger>
          <TooltipContent>
            <Show
              when={props.skillDelivery.error}
              fallback="The organization's Skills have not landed in this workspace yet."
            >
              {(error) => <>Skill delivery failed: {error()}</>}
            </Show>
          </TooltipContent>
        </Tooltip>
      </Show>

      <Show when={props.agentUpdate}>
        {(update) => (
          <Tooltip>
            <TooltipTrigger
              as="span"
              class={cn(
                'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium',
                agentUpdateBad(update().status)
                  ? 'border border-red-200 bg-red-50 text-red-700'
                  : 'border border-sky-200 bg-sky-50 text-sky-700'
              )}
            >
              <AlertTriangle class="size-3" />
              Agent content {agentUpdateLabel(update().status)}
            </TooltipTrigger>
            <TooltipContent>
              <Show
                when={update().error}
                fallback={`This workspace is behind the agent image's content (target ${update().targetVersion}).`}
              >
                {(error) => <>Agent update failed: {error()}</>}
              </Show>
            </TooltipContent>
          </Tooltip>
        )}
      </Show>

      <Show when={props.drift}>
        <Tooltip>
          <TooltipTrigger
            as="span"
            class="inline-flex items-center gap-1 rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700"
          >
            <AlertTriangle class="size-3" />
            Drift
          </TooltipTrigger>
          <TooltipContent>
            Pod is running, but its environment is marked {props.dbStatus} in the database.
          </TooltipContent>
        </Tooltip>
      </Show>
    </div>
  );
}
