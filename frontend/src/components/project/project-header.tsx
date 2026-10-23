import { Show, createSignal, untrack, type Component, type JSX } from 'solid-js';
import { useQueryClient } from '@tanstack/solid-query';
import { usePermissions } from '~/api/permissions';
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

export const PROJECT_TAB_LABELS: Record<ProjectTab, string> = {
  chat: 'Chat',
  files: 'Files',
  code: 'Code',
  db: 'DB',
};

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
  const canViewCode = () => hasPermission('can_view_code_tab');
  const canViewDb = () => hasPermission('can_view_db_tab');
  const projectQuery = useProject(() => props.projectId);
  const project = () => projectQuery.data;

  const handleEnvironmentDeleted = (environmentId: string) => {
    if (props.activeEnvironmentId === environmentId) {
      props.onActiveEnvironmentChange(props.projectId);
    }
  };

  return (
    <div class="flex items-center justify-between gap-2 px-3 sm:pr-5 py-2 bg-background border-b border-border shrink-0">
      <div class="flex items-center gap-2 min-w-0">
        {props.headerLabel}
        <Tabs
          value={props.activeTab}
          onChange={(v) => props.onActiveTabChange(v as ProjectTab)}
          class="w-auto shrink-0"
        >
          <TabsList class="w-auto">
            <ProjectTabTrigger value="chat" icon={MessageSquare} onPress={props.onActiveTabChange} />
            <ProjectTabTrigger value="files" icon={Files} onPress={props.onActiveTabChange} />
            <Show when={props.showAgentTabs && canViewCode()}>
              <ProjectTabTrigger value="code" icon={CodeIcon} onPress={props.onActiveTabChange} />
            </Show>
            <Show when={props.showAgentTabs && canViewDb()}>
              <ProjectTabTrigger value="db" icon={Database} onPress={props.onActiveTabChange} />
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

function ProjectTabTrigger(props: {
  value: ProjectTab;
  icon: Component<{ class?: string }>;
  onPress: (tab: ProjectTab) => void;
}) {
  const label = () => PROJECT_TAB_LABELS[props.value];
  return (
    <TabsTrigger
      value={props.value}
      class="flex-none gap-1.5"
      aria-label={label()}
      title={label()}
      onClick={() => props.onPress(props.value)}
    >
      <props.icon class="w-3.5 h-3.5" />
      <span class="hidden sm:inline">{label()}</span>
    </TabsTrigger>
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
