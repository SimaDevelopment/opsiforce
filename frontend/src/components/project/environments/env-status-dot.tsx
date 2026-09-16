import { Show } from 'solid-js';
import { cn } from '~/lib/cn';
import type { ProjectEnvironmentStatus } from '~/api/environments';
import { envStatusMeta } from './env-status';

export interface EnvStatusDotProps {
  status: ProjectEnvironmentStatus;
  withLabel?: boolean;
  class?: string;
}

export function EnvStatusDot(props: EnvStatusDotProps) {
  const meta = () => envStatusMeta(props.status);
  return (
    <span class={cn('inline-flex items-center gap-1.5 shrink-0', props.class)}>
      <span class="relative inline-flex h-2 w-2 shrink-0">
        <Show when={meta().pulse}>
          <span class={cn('absolute inline-flex h-full w-full rounded-full opacity-60 animate-ping', meta().dot)} />
        </Show>
        <span class={cn('relative inline-flex h-2 w-2 rounded-full', meta().dot)} />
      </span>
      <Show when={props.withLabel}>
        <span class={cn('text-xs font-medium', meta().text)}>{meta().label}</span>
      </Show>
    </span>
  );
}
