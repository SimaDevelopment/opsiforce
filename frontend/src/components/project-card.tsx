import { Show, createSignal } from 'solid-js';
import { isAgentWorking } from '~/api/agent-status';
import type { Project } from '~/api/client';
import { cn } from '~/lib/cn';
import { projectDisplayTitle } from '~/lib/project-display';
import { EnvironmentBadges } from './project/environment-badges';
import { ProjectActionsMenu } from './project-actions-menu';
import { Spinner } from '~/components/ui/spinner';

export function ProjectCard(props: {
  project: Project;
  isActive: boolean;
  onSelect: () => void;
  onRename: (id: string, title: string) => void;
  onSettings?: () => void;
  onDeleted?: () => void;
}) {
  const isDisabled = () => props.project.status === 'disabled';

  const [editing, setEditing] = createSignal(false);
  const [editValue, setEditValue] = createSignal('');

  const title = () => projectDisplayTitle(props.project);

  function startRename() {
    setEditValue(props.project.title ?? '');
    setEditing(true);
  }

  function commitRename() {
    const val = editValue().trim();
    if (val && val !== props.project.title) {
      props.onRename(props.project.id, val);
    }
    setEditing(false);
  }

  function cancelRename() {
    setEditing(false);
  }

  function handleCardClick(e: MouseEvent & { currentTarget: HTMLElement; target: Element }) {
    const retargetedFromPortal = !e.currentTarget.contains(e.target);
    if (editing() || retargetedFromPortal) return;
    props.onSelect();
  }

  return (
    <div
      onClick={handleCardClick}
      class={cn(
        'w-full text-left rounded-lg px-2.5 py-2 transition-all duration-150 group relative cursor-pointer',
        props.isActive ? 'bg-background shadow-sm ring-1 ring-black/[0.04]' : 'hover:bg-sidebar-accent/60'
      )}
    >
      <div class="flex items-center gap-2 min-w-0">
        <div class="flex-1 min-w-0">
          <Show
            when={!editing()}
            fallback={
              <input
                ref={(el) => setTimeout(() => el.focus(), 0)}
                value={editValue()}
                onInput={(e) => setEditValue(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename();
                  if (e.key === 'Escape') cancelRename();
                }}
                onBlur={commitRename}
                onClick={(e) => e.stopPropagation()}
                class="w-full text-xs font-medium text-sidebar-foreground bg-background border border-input rounded px-1.5 py-0.5 outline-none focus:ring-1 focus:ring-ring"
              />
            }
          >
            <div class="flex items-center gap-1 min-w-0">
              <Show when={isAgentWorking(props.project.id)}>
                <span role="status" aria-label="Agent working" class="flex items-center shrink-0">
                  <Spinner size="xs" />
                </span>
              </Show>
              <span
                class={cn(
                  'block text-xs font-medium truncate leading-tight flex-1 min-w-0',
                  isDisabled() ? 'text-sidebar-muted-foreground' : 'text-sidebar-foreground'
                )}
              >
                {title()}
              </span>
            </div>
          </Show>
          <Show when={!editing()}>
            <div class="flex items-center gap-1.5 mt-0.5">
              <Show when={isDisabled()}>
                <span class="text-xs text-sidebar-muted-foreground">Disabled</span>
              </Show>
              <EnvironmentBadges environmentIds={props.project.environmentIds} dimmed={isDisabled()} />
            </div>
          </Show>
        </div>

        <Show when={!editing()}>
          <ProjectActionsMenu
            projectId={props.project.id}
            status={props.project.status}
            workspaceId={props.project.workspaceId}
            project={props.project}
            showRename
            onRename={startRename}
            onSettings={props.onSettings}
            onDeleted={props.onDeleted}
            triggerClass={cn(
              'inline-flex items-center justify-center rounded-md w-6 h-6 shrink-0 text-sidebar-muted-foreground transition-colors',
              'opacity-0 group-hover:opacity-100',
              'hover:text-sidebar-foreground hover:bg-sidebar-accent',
              props.isActive && 'opacity-100'
            )}
            onTriggerClick={(e) => e.stopPropagation()}
          />
        </Show>
      </div>
    </div>
  );
}
