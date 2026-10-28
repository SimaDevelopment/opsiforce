import { Show, createMemo } from 'solid-js';
import { useProjectEnvironments } from '~/api/environments';
import { isAgentWorking } from '~/api/agent-status';
import { Clock, TriangleAlert } from '~/components/icons';

/**
 * The open project says more than its name.
 *
 * In the list a project is one line, but the one you are working in is the
 * screen's subject: the row expands in place and states where it is deployed
 * and whether anything is happening. Only facts the API actually carries are
 * shown — there is no publish timestamp in the model, so this says where a
 * build is live rather than inventing how long ago it got there.
 */
export function OpenProjectFacts(props: { projectId: string }) {
  const environments = useProjectEnvironments(() => props.projectId);

  const deployedTo = createMemo(() =>
    (environments.data ?? []).filter((env) => env.deployedCommitSha !== null).map((env) => env.name)
  );

  const working = () => isAgentWorking(props.projectId);

  const published = createMemo(() => {
    const names = deployedTo();
    if (names.length === 0) return null;
    if (names.length === 1) return `Published to ${names[0]}`;
    return `Published to ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  });

  return (
    <Show when={published() || working()}>
      <div class="flex flex-col gap-1 mt-2">
        <Show when={published()}>
          {(text) => (
            <span class="flex items-center gap-1.5 t-meta t-sub min-w-0">
              <Clock class="w-3 h-3 shrink-0" />
              <span class="truncate">{text()}</span>
            </span>
          )}
        </Show>
        <Show when={!published() && working()}>
          <span class="flex items-center gap-1.5 t-meta t-sub min-w-0">
            <TriangleAlert class="w-3 h-3 shrink-0" />
            <span class="truncate">Not published yet</span>
          </span>
        </Show>
        <Show when={working()}>
          <span class="flex items-center gap-1.5 t-meta min-w-0" style={{ color: 'var(--ink-accent)' }}>
            <span class="of-working">
              <i />
              <i />
              <i />
            </span>
            <span class="truncate">The agent is working</span>
          </span>
        </Show>
      </div>
    </Show>
  );
}
