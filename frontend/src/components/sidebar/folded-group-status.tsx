import { Show } from 'solid-js';
import { isAgentWaiting } from '~/api/agent-status';
import type { Project } from '~/api/client';

/**
 * What a folded workspace or folder would otherwise hide. A chat waiting for
 * an answer outranks a broken project, because only the first is someone's
 * move; with the group open, the rows carry their own markers.
 */
export function FoldedGroupStatus(props: { projects: Project[]; folded: boolean }) {
  const status = () => {
    if (!props.folded) return undefined;
    if (props.projects.some((p) => isAgentWaiting(p.id))) {
      return { tone: 'of-tone-needs-you', label: 'A chat in here is waiting for an answer' };
    }
    if (props.projects.some((p) => p.status === 'failed')) {
      return { tone: 'of-tone-failed', label: 'A project in here has failed' };
    }
    return undefined;
  };

  return (
    <Show when={status()}>
      {(s) => <span role="status" aria-label={s().label} title={s().label} class={`of-dot ${s().tone} shrink-0`} />}
    </Show>
  );
}
