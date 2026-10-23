import { Show, children, type Component, type ParentProps } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { LoaderCircle } from '~/components/icons';
import { cn } from '~/lib/cn';

export type ProjectStateTone = 'neutral' | 'warning' | 'danger';

const BADGE_BY_TONE: Record<ProjectStateTone, string> = {
  neutral: 'bg-muted text-muted-foreground',
  warning: 'bg-amber-500/10 text-amber-600',
  danger: 'bg-destructive/10 text-destructive',
};

export function ProjectStatePanel(
  props: ParentProps<{
    title: string;
    description?: string;
    icon?: Component<{ class?: string }>;
    tone?: ProjectStateTone;
    busy?: boolean;
  }>
) {
  const actions = children(() => props.children);
  const tone = () => props.tone ?? 'neutral';

  return (
    <div
      class="flex h-full items-center justify-center p-6"
      role={props.busy ? 'status' : tone() === 'neutral' ? undefined : 'alert'}
    >
      <div class="flex max-w-sm flex-col items-center text-center">
        <div class={cn('mb-4 flex h-12 w-12 items-center justify-center rounded-full', BADGE_BY_TONE[tone()])}>
          <Show when={!props.busy} fallback={<LoaderCircle class="h-5 w-5 animate-spin" aria-hidden="true" />}>
            <Dynamic component={props.icon} class="h-5 w-5" aria-hidden="true" />
          </Show>
        </div>
        <p class="text-sm font-medium text-foreground">{props.title}</p>
        <Show when={props.description}>
          <p class="mt-1.5 text-sm leading-relaxed text-muted-foreground">{props.description}</p>
        </Show>
        <Show when={actions.toArray().some(Boolean)}>
          <div class="mt-5 flex flex-wrap items-center justify-center gap-2">{actions()}</div>
        </Show>
      </div>
    </div>
  );
}
