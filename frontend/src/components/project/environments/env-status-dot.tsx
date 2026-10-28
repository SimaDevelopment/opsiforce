import { Show } from 'solid-js';
import { cn } from '~/lib/cn';
import type { ProjectEnvironmentStatus } from '~/api/environments';
import { envStatusMeta } from './env-status';

export interface EnvStatusDotProps {
  status: ProjectEnvironmentStatus;
  withLabel?: boolean;
  class?: string;
}

/** The tone sits on the wrapper, so the dot, its ping and the label all inherit it. */
export function EnvStatusDot(props: EnvStatusDotProps) {
  const meta = () => envStatusMeta(props.status);
  return (
    <span class={cn('inline-flex items-center gap-1.5 shrink-0', meta().tone, props.class)}>
      <span class="relative inline-flex h-2 w-2 shrink-0">
        <Show when={meta().pulse}>
          <span class="of-dot absolute inline-flex h-full w-full opacity-60 animate-ping" />
        </Show>
        <span class="of-dot relative inline-flex h-2 w-2" />
      </span>
      <Show when={props.withLabel}>
        <span class="of-ink t-meta">{meta().label}</span>
      </Show>
    </span>
  );
}
