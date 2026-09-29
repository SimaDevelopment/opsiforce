import { Show, createSignal, untrack, type JSX } from 'solid-js';
import { useQueryClient } from '@tanstack/solid-query';
import { usePermissions } from '~/api/permissions';
import { Permission } from '~/constants/permissions';
import { projectKeys, useProject, useRenameProject } from '~/api/projects';
import { projectTitleOf } from '~/lib/project-title';
import { Code as CodeIcon, Database, Files, MessageSquare } from '~/components/icons';
import { Badge } from '~/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '~/components/ui/tabs';
import { ProjectActionsMenu } from '~/components/project-actions-menu';
import { EnvironmentsPopover } from '~/components/project/environments/environments-popover';
import type { ProjectStatus } from '~/api/client';
import type { ProjectEnvironment } from '~/api/environments';

export type ProjectTab = 'chat' | 'files' | 'code' | 'db';

export interface ProjectSurfaceSlots {
  headerLabel?: JSX.Element;
  menuItems?: JSX.Element;
  deleteDescription?: string;
  deleteEscapeHatch?: (dismiss: () => void) => JSX.Element;
  onRename?: () => void;
}

export interface ProjectHeaderProps extends ProjectSurfaceSlots {
  projectId: string;
  status: ProjectStatus;
  workspaceId: string | null;
  appExists: boolean;
  showAgentTabs: boolean;
  activeTab: ProjectTab;
  onActiveTabChange: (tab: ProjectTab) => void;
  environments: ProjectEnvironment[];
  activeEnvironmentId: string;
  onActiveEnvironmentChange: (environmentId: string) => void;
  onDeleted: () => void;
}

export function ProjectHeader(props: ProjectHeaderProps) {
  const { hasPermission } = usePermissions();
  const canViewCode = () => hasPermission(Permission.viewCodeTab);
  const canViewDb = () => hasPermission(Permission.viewDbTab);
  const projectQuery = useProject(() => props.projectId);
  const project = () => projectQuery.data;

  const handleEnvironmentDeleted = (environmentId: string) => {
    if (props.activeEnvironmentId === environmentId) {
      props.onActiveEnvironmentChange(props.projectId);
    }
  };

  return (
    <div class="flex items-center justify-between gap-2 pl-3 pr-5 py-2 bg-background border-b border-border shrink-0">
      <div class="flex items-center gap-2 min-w-0">
        {props.headerLabel}
        <Tabs value={props.activeTab} onChange={(v) => props.onActiveTabChange(v as ProjectTab)} class="w-auto">
          <TabsList class="w-auto">
            <TabsTrigger value="chat" class="flex-none gap-1.5">
              <MessageSquare class="w-3.5 h-3.5" />
              Chat
            </TabsTrigger>
            <TabsTrigger value="files" class="flex-none gap-1.5">
              <Files class="w-3.5 h-3.5" />
              Files
            </TabsTrigger>
            <Show when={props.showAgentTabs && canViewCode()}>
              <TabsTrigger value="code" class="flex-none gap-1.5">
                <CodeIcon class="w-3.5 h-3.5" />
                Code
              </TabsTrigger>
            </Show>
            <Show when={props.showAgentTabs && canViewDb()}>
              <TabsTrigger value="db" class="flex-none gap-1.5">
                <Database class="w-3.5 h-3.5" />
                DB
              </TabsTrigger>
            </Show>
          </TabsList>
        </Tabs>
        <Show when={project()?.kind === null}>
          <EnvironmentsPopover
            projectId={props.projectId}
            environments={props.environments}
            activeEnvironmentId={props.activeEnvironmentId}
            onActiveEnvironmentChange={props.onActiveEnvironmentChange}
            onEnvironmentDeleted={handleEnvironmentDeleted}
          />
        </Show>
        <Show when={project()?.importedAgent}>
          {(slug) => (
            <Badge variant="info" class="shrink-0 font-normal">
              Imported agent: {slug()} (not in this organization)
            </Badge>
          )}
        </Show>
      </div>

      <div class="flex items-center gap-1.5 shrink-0">
        <ProjectActionsMenu
          projectId={props.projectId}
          status={props.status}
          workspaceId={props.workspaceId}
          project={project()}
          activeEnvironmentId={props.activeEnvironmentId}
          onDeleted={props.onDeleted}
          extraItems={props.menuItems}
          deleteDescription={props.deleteDescription}
          deleteEscapeHatch={props.deleteEscapeHatch}
          showRename={props.onRename !== undefined}
          onRename={props.onRename}
        />
      </div>
    </div>
  );
}

export function ProjectTitleLabel(props: { projectId: string; editing?: boolean; onEditDone?: () => void }) {
  const project = useProject(() => props.projectId);
  const title = () => projectTitleOf(project.data);
  return (
    <Show
      when={props.editing}
      fallback={
        <span class="max-w-48 shrink-0 truncate text-sm font-medium" title={title()}>
          {title()}
        </span>
      }
    >
      <ProjectTitleInput projectId={props.projectId} title={title()} onDone={() => props.onEditDone?.()} />
    </Show>
  );
}

function ProjectTitleInput(props: { projectId: string; title: string; onDone: () => void }) {
  const qc = useQueryClient();
  const rename = useRenameProject();
  const [draft, setDraft] = createSignal(untrack(() => props.title));

  const commit = () => {
    const next = draft().trim();
    props.onDone();
    if (!next || next === props.title) return;
    rename.mutate(
      { id: props.projectId, title: next },
      { onSettled: () => qc.invalidateQueries({ queryKey: projectKeys.detail(props.projectId) }) }
    );
  };

  return (
    <input
      type="text"
      aria-label="Project title"
      autofocus
      value={draft()}
      onInput={(event) => setDraft(event.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') {
          setDraft(props.title);
          event.currentTarget.blur();
        }
      }}
      class="w-48 shrink-0 rounded-md border border-border bg-background px-2 py-1 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
    />
  );
}
