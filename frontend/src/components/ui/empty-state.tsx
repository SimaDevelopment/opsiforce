import { Show, type Component, type JSX } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { cn } from '~/lib/cn';
import { Lattice } from './lattice';

/**
 * The one empty state in the product: the lattice as absence texture, a title
 * that says what is not here, one sentence of why, and the action that would
 * fill it. A screen with nothing in it is still a designed screen.
 */
export function EmptyState(props: {
  icon?: Component<{ class?: string }>;
  title: string;
  description?: string;
  action?: JSX.Element;
  class?: string;
}) {
  return (
    <div class={cn('of-empty', props.class)}>
      <Lattice variant="empty" />
      <Show when={props.icon}>
        {(Icon) => (
          <span class="relative" style={{ color: 'var(--ink-subtle)' }}>
            <Dynamic component={Icon()} class="w-5 h-5" />
          </span>
        )}
      </Show>
      <p class="ttl">{props.title}</p>
      <Show when={props.description}>
        <p class="ds">{props.description}</p>
      </Show>
      <Show when={props.action}>
        <div class="acts">{props.action}</div>
      </Show>
    </div>
  );
}
