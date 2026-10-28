import type { Environment } from '~/api/environments';
import { cn } from '~/lib/cn';
import { environmentBadgeLabel } from '~/lib/environment-label';

/**
 * An environment's identity is its colour, but the colour is never the only
 * signal: the badge always carries its short label and a dot, and the text is
 * theme ink rather than a tint of the environment colour, so it keeps its
 * contrast in both light and dark. The colour is configured per environment,
 * so it arrives as a value rather than a token.
 */
export function EnvironmentBadge(props: {
  environment: Pick<Environment, 'name' | 'slug' | 'shortName' | 'color'>;
  /** `sm` is for dense lists (sidebar rows), where the full pill would own the row. */
  size?: 'default' | 'sm';
  class?: string;
}) {
  return (
    <span
      class={cn('of-env', props.size === 'sm' && 'of-env-sm', props.class)}
      style={{ '--env-color': props.environment.color }}
    >
      <span class="of-dot" />
      {environmentBadgeLabel(props.environment)}
    </span>
  );
}
