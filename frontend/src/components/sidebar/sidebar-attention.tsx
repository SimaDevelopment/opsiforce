import { For, Show, createMemo } from 'solid-js';
import { useNavigate } from '@tanstack/solid-router';
import { isAgentWorking } from '~/api/agent-status';
import { useProjects } from '~/api/projects';
import { useWorkspaces } from '~/api/workspaces';
import { describeJob } from '~/components/project/jobs/job-kind';
import { useJobDock } from '~/components/project/jobs/job-dock-context';
import { projectDisplayTitle } from '~/lib/project-display';

/**
 * What demands attention, above the tree.
 *
 * The sidebar listed every project alphabetically and nothing else, so a
 * failed export and a project disabled under you read exactly like a project
 * you have not opened in a month. These two sections are assembled from state
 * the shell already holds — the job dock's entries and the agent-status
 * stream — so they cost no request and cannot drift from what the rest of the
 * UI shows.
 */

interface AttentionRow {
  id: string;
  title: string;
  detail: string;
  tone: string;
  projectId?: string;
}

function Section(props: { title: string; rows: AttentionRow[]; pulse?: boolean }) {
  const navigate = useNavigate();
  const open = (projectId?: string) => {
    if (!projectId) return;
    navigate({
      to: '/projects/$projectId',
      params: { projectId },
      search: { prompt: undefined, promptId: undefined },
    });
  };

  return (
    <Show when={props.rows.length > 0}>
      <div class="px-2">
        <div class="of-sb-sec-head">
          <span class="ttl">{props.title}</span>
          <span class="of-count">{props.rows.length}</span>
        </div>
        <For each={props.rows}>
          {(row) => (
            <button
              type="button"
              class="of-row fr-panel items-start"
              style={{ height: 'auto', 'min-height': 'var(--row-h)', padding: '6px var(--row-pad)' }}
              onClick={() => open(row.projectId)}
              disabled={!row.projectId}
            >
              <span
                class={props.pulse ? 'of-dot of-dot-pulse mt-1.5' : 'of-dot mt-1.5'}
                style={{ background: row.tone }}
              />
              <span class="flex flex-col gap-px min-w-0 flex-1 text-left">
                <span class="t-ui-med truncate" style={{ color: 'var(--ink-strong)' }}>
                  {row.title}
                </span>
                <span class="t-meta t-sub truncate">{row.detail}</span>
              </span>
            </button>
          )}
        </For>
      </div>
    </Show>
  );
}

export function SidebarAttention() {
  const projects = useProjects();
  const workspaces = useWorkspaces();
  const dock = useJobDock();

  const workspaceName = (id: string | null) =>
    (id && workspaces.data?.find((w) => w.id === id)?.name) || 'No workspace';

  const needsYou = createMemo<AttentionRow[]>(() => {
    const rows: AttentionRow[] = [];

    // a run that stopped and is waiting on a decision
    for (const entry of dock.entries()) {
      const display = describeJob(entry);
      if (display.phase !== 'failed') continue;
      rows.push({
        id: `job:${entry.key}`,
        title: display.cardTitle,
        detail: display.error ?? display.stepLabel ?? 'Stopped — open it to see why',
        tone: 'var(--job-failed)',
        projectId: 'projectId' in entry && typeof entry.projectId === 'string' ? entry.projectId : undefined,
      });
    }

    // a project someone turned off: it is still listed, but nothing runs
    for (const project of projects.data ?? []) {
      if (project.status !== 'disabled') continue;
      rows.push({
        id: `disabled:${project.id}`,
        title: projectDisplayTitle(project),
        detail: `${workspaceName(project.workspaceId)} · disabled`,
        tone: 'var(--ink-subtle)',
        projectId: project.id,
      });
    }

    return rows;
  });

  const running = createMemo<AttentionRow[]>(() =>
    (projects.data ?? [])
      .filter((project) => isAgentWorking(project.id))
      .map((project) => ({
        id: `running:${project.id}`,
        title: projectDisplayTitle(project),
        detail: `${workspaceName(project.workspaceId)} · the agent is working`,
        tone: 'var(--job-running)',
        projectId: project.id,
      }))
  );

  return (
    <>
      <Section title="Needs you" rows={needsYou()} />
      <Section title="Running" rows={running()} pulse />
    </>
  );
}
