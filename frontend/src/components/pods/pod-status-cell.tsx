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
  /** a tone setter for the row — the dot and, when bad, the label read it */
  tone: string;
  label: string;
  bad: boolean;
}

export function statusVisual(status: PodStatus): StatusVisual {
  if (status.reason === 'CrashLoopBackOff') return { tone: 'of-tone-failed', label: 'CrashLoopBackOff', bad: true };
  if (status.reason === 'ImagePullBackOff') return { tone: 'of-tone-failed', label: 'Image pull error', bad: true };
  if (status.reason === 'Unschedulable') return { tone: 'of-tone-failed', label: 'Unschedulable', bad: true };
  if (status.phase === 'terminating') return { tone: 'of-tone-stopping', label: 'Terminating', bad: false };
  if (status.phase === 'running') {
    return status.ready
      ? { tone: 'of-tone-done', label: 'Running', bad: false }
      : { tone: 'of-tone-needs-you', label: 'Not ready', bad: false };
  }
  if (status.phase === 'pending') return { tone: 'of-tone-needs-you', label: 'Pending', bad: false };
  if (status.phase === 'failed') return { tone: 'of-tone-failed', label: 'Failed', bad: true };
  if (status.phase === 'succeeded') return { tone: 'of-tone-neutral', label: 'Completed', bad: false };
  return { tone: 'of-tone-neutral', label: 'Unknown', bad: false };
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
    <div class={cn('flex items-center gap-2', visual().tone)}>
      <span class="of-dot size-2" />
      <span class={cn('t-meta', visual().bad ? 'of-ink t-ui-med' : 'text-foreground')}>{visual().label}</span>

      <Show when={props.status.restartCount > 0}>
        <Tooltip>
          <TooltipTrigger
            as="span"
            class="inline-flex items-center gap-0.5 text-[0.6875rem] tabular-nums text-muted-foreground"
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
              'of-note of-note-sm',
              props.skillDelivery.failedAt === null ? 'of-tone-running' : 'of-tone-failed'
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
              class={cn('of-note of-note-sm', agentUpdateBad(update().status) ? 'of-tone-failed' : 'of-tone-running')}
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
            class="of-note of-note-sm of-tone-needs-you"
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
