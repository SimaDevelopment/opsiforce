import { For, Show, createMemo } from 'solid-js';
import { useNavigate } from '@tanstack/solid-router';
import { isAgentWaiting, isAgentWorking } from '~/api/agent-status';
import type { Project } from '~/api/client';
import { useProjects } from '~/api/projects';
import { useWorkspaces } from '~/api/workspaces';
import { ChevronDown, ChevronRight } from '~/components/icons';
import { createPersistedSignal } from '~/lib/persisted-signal';
import { projectDisplayTitle } from '~/lib/project-display';

/**
 * Live chat state, above the tree.
 *
 * Waiting for input holds one thing only: a chat waiting for an answer or a
 * permission, the one state where nothing moves until someone acts. Every
 * member of the Project sees it, since anyone can answer. Broken
 * and disabled projects are marked on their own rows instead, and a failed
 * run stays on its card in the runs dock. Running is every chat working right
 * now that is not waiting. Both read the agent-status stream, so they cost no
 * request and cannot drift from the rows below. A folded section keeps its
 * count in the header.
 */

const SECTIONS_FOLDED_KEY = 'opsiforce:sidebar:sections-folded';

type SectionId = 'waiting' | 'running';

interface AttentionRow {
  id: string;
  title: string;
  detail: string;
  tone: string;
  projectId?: string;
}

function Section(props: {
  title: string;
  rows: AttentionRow[];
  folded: boolean;
  onToggleFold: () => void;
  pulse?: boolean;
}) {
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
      <div class="px-2 pt-2">
        <button type="button" class="of-sb-sec-head" aria-expanded={!props.folded} onClick={props.onToggleFold}>
          {props.folded ? <ChevronRight class="w-3 h-3 shrink-0" /> : <ChevronDown class="w-3 h-3 shrink-0" />}
          <span class="ttl">{props.title}</span>
          <span class="of-count">{props.rows.length}</span>
        </button>
        <For each={props.folded ? [] : props.rows}>
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
  const [folded, setFolded] = createPersistedSignal<Partial<Record<SectionId, boolean>>>(SECTIONS_FOLDED_KEY, {});
  const toggle = (id: SectionId) => setFolded((prev) => ({ ...prev, [id]: !prev[id] }));

  const workspaceName = (id: string | null) =>
    (id && workspaces.data?.find((w) => w.id === id)?.name) || 'No workspace';

  const row = (project: Project, kind: SectionId): AttentionRow => ({
    id: `${kind}:${project.id}`,
    title: projectDisplayTitle(project),
    detail: workspaceName(project.workspaceId),
    tone: kind === 'waiting' ? 'var(--job-needs-you)' : 'var(--job-running)',
    projectId: project.id,
  });

  const waiting = createMemo<AttentionRow[]>(() =>
    (projects.data ?? []).filter((p) => isAgentWaiting(p.id)).map((p) => row(p, 'waiting'))
  );

  const running = createMemo<AttentionRow[]>(() =>
    (projects.data ?? []).filter((p) => isAgentWorking(p.id) && !isAgentWaiting(p.id)).map((p) => row(p, 'running'))
  );

  return (
    <>
      <Section
        title="Waiting for input"
        rows={waiting()}
        folded={folded().waiting === true}
        onToggleFold={() => toggle('waiting')}
      />
      <Section
        title="Running"
        rows={running()}
        folded={folded().running === true}
        onToggleFold={() => toggle('running')}
        pulse
      />
    </>
  );
}
