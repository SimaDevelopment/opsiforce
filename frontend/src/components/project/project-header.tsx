import { Show, createSignal, untrack, type Component, type JSX } from 'solid-js';
import { useNavigate } from '@tanstack/solid-router';
import { revealInSidebar } from '~/lib/sidebar-reveal';
import { useQueryClient } from '@tanstack/solid-query';
import { usePermissions } from '~/api/permissions';
import { projectKeys, useProject, useRenameProject } from '~/api/projects';
import { projectTitleOf } from '~/lib/project-title';
import { useWorkspaces, useWorkspaceFolders } from '~/api/workspaces';
import { ChevronRight, Code as CodeIcon, Command, Database, Files, MessageSquare, Moon, Sun } from '~/components/icons';
import { PALETTE_SHORTCUT, openCommandPalette } from '~/components/command-palette';
import { useAppearance } from '~/lib/appearance';
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
  const appearance = useAppearance();

  const handleEnvironmentDeleted = (environmentId: string) => {
    if (props.activeEnvironmentId === environmentId) {
      props.onActiveEnvironmentChange(props.projectId);
    }
  };

  return (
    <div class="of-band justify-between sm:pr-4">
      <div class="of-band-lead">
        {props.headerLabel}
        <Tabs
          value={props.activeTab}
          onChange={(v) => props.onActiveTabChange(v as ProjectTab)}
          class="w-auto shrink-0 self-stretch flex"
        >
          <TabsList variant="folder" class="w-auto">
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
        <Show when={project()?.importedAgent}>
          {(slug) => (
            <Badge variant="info" class="shrink-0 font-normal">
              Imported agent: {slug()} (not in this organization)
            </Badge>
          )}
        </Show>
      </div>

      {/* The environment and Publish belong on the right, with the chrome:
          the left of the band says where you are, the right says what you can
          do with it. */}
      <div class="flex items-center gap-1.5 shrink-0">
        <Show when={project()?.kind === null}>
          <EnvironmentsPopover
            projectId={props.projectId}
            showPublishButton
            environments={props.environments}
            activeEnvironmentId={props.activeEnvironmentId}
            onActiveEnvironmentChange={props.onActiveEnvironmentChange}
            onEnvironmentDeleted={handleEnvironmentDeleted}
          />
        </Show>
        {/* The two controls the band keeps in every screen of the design: one
            way into everything, and the light/dark switch. On a phone they
            give way to the tabs and Publish; both remain reachable through the
            shortcut and Settings > Appearance. */}
        <button
          type="button"
          class="of-btn of-btn-icon of-btn-ghost fr hidden sm:inline-flex"
          onClick={openCommandPalette}
          aria-label="Go to"
          aria-keyshortcuts="Meta+K Control+K"
          title={`Go to (${PALETTE_SHORTCUT})`}
        >
          <Command class="w-4 h-4" />
        </button>
        <button
          type="button"
          class="of-btn of-btn-icon of-btn-ghost fr hidden sm:inline-flex"
          onClick={() => appearance.setMode(appearance.scheme() === 'dark' ? 'light' : 'dark')}
          aria-label={appearance.scheme() === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          title={appearance.scheme() === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          <Show when={appearance.scheme() === 'dark'} fallback={<Moon class="w-4 h-4" />}>
            <Sun class="w-4 h-4" />
          </Show>
        </button>
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
      class="of-tab flex-none"
      aria-label={label()}
      title={label()}
      onClick={() => props.onPress(props.value)}
    >
      <props.icon class="w-3.5 h-3.5" />
      <span class="hidden sm:inline">{label()}</span>
    </TabsTrigger>
  );
}

/**
 * The band's one piece of orientation: which workspace this project sits in,
 * then the project. The trail replaces a bare title because a project name on
 * its own does not say where you are.
 */
export function ProjectTitleLabel(props: { projectId: string; editing?: boolean; onEditDone?: () => void }) {
  const project = useProject(() => props.projectId);
  const workspaces = useWorkspaces();
  const navigate = useNavigate();
  const workspaceId = () => project.data?.workspaceId ?? '';
  const folders = useWorkspaceFolders(workspaceId);
  const title = () => projectTitleOf(project.data);
  const workspaceName = () => {
    const id = project.data?.workspaceId;
    if (!id) return undefined;
    return workspaces.data?.find((w) => w.id === id)?.name;
  };
  const folderName = () => {
    const id = project.data?.folderId;
    if (!id) return undefined;
    return folders.data?.find((f) => f.id === id)?.name;
  };
  // Every crumb above the last one goes home with the sidebar revealing that
  // group, which is where this product keeps its workspaces and folders.
  const goUp = (reveal: { workspace?: string; folder?: string }) => {
    revealInSidebar(reveal);
    navigate({ to: '/' });
  };
  return (
    <Show
      when={props.editing}
      fallback={
        <nav class="of-crumbs" aria-label="Breadcrumb">
          <Show when={workspaceName()}>
            {(name) => (
              <>
                <button
                  type="button"
                  class="fr truncate"
                  title={`Go to ${name()}`}
                  onClick={() => goUp({ workspace: workspaceId() })}
                >
                  {name()}
                </button>
                <ChevronRight class="sep" aria-hidden="true" />
              </>
            )}
          </Show>
          <Show when={folderName()}>
            {(name) => (
              <>
                <button
                  type="button"
                  class="fr truncate"
                  title={`Go to ${name()}`}
                  onClick={() => goUp({ workspace: workspaceId(), folder: project.data?.folderId ?? undefined })}
                >
                  {name()}
                </button>
                <ChevronRight class="sep" aria-hidden="true" />
              </>
            )}
          </Show>
          <span class="last truncate" aria-current="page" title={title()}>
            {title()}
          </span>
        </nav>
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
