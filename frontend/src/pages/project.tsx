import { Show, createEffect, createMemo, createSignal, on, onCleanup, untrack, type JSX } from 'solid-js';
import { useNavigate } from '@tanstack/solid-router';
import { usePermissions } from '~/api/permissions';
import { onAppServing, onEnvironmentIdle } from '~/api/agent-status';
import { ApiError } from '~/api/client';
import { useProjectStatus } from '~/api/projects';
import { useProjectEnvironments } from '~/api/environments';
import { deletionCoversPath } from '~/api/files';
import {
  PROJECT_TAB_LABELS,
  ProjectHeader,
  type ProjectSurfaceSlots,
  type ProjectTab,
} from '~/components/project/project-header';
import { ProjectChatTab } from '~/components/project/project-chat-tab';
import { ProjectCodeTab } from '~/components/project/project-code-tab';
import { ProjectDbTab } from '~/components/project/project-db-tab';
import { ProjectFilesTab } from '~/components/project/files';
import { ProjectMobileNav, type ProjectMobileDestination } from '~/components/project/project-mobile-nav';
import { ProjectTabsContext } from '~/components/project/project-tabs-context';
import { ProjectUsersTab } from '~/components/project/users/project-users-tab';
import { ProjectPreviewPanel, type FilePreviewRequest } from '~/components/project/preview';
import {
  ProjectConnecting,
  ProjectConnectionProblem,
  ProjectDisabled,
  ProjectFailed,
} from '~/components/project/project-states';
import { EnvProdBanner } from '~/components/project/environments/env-prod-banner';
import { useJobDock } from '~/components/project/jobs/job-dock-context';
import { useOpenCodeConnection, type InitialPrompt } from '~/components/project/use-opencode-connection';
import { usePaneStripSlot } from '~/components/ui/pane-strip';
import { useSidebar } from '~/components/ui/sidebar';
import { ResizeHandle } from '~/components/ui/resize-handle';
import { createResizablePanel } from '~/lib/create-resizable-panel';
import { CHAT_COLUMN } from '~/lib/pane-widths';
import { cn } from '~/lib/cn';

export interface ProjectViewProps extends ProjectSurfaceSlots {
  projectId: string;
  initialPrompt: () => InitialPrompt | undefined;
  onInitialPromptAdmitted: () => void;
  onGone?: () => void;
  footer?: JSX.Element;
  onStatusEvent?: () => void;
  onPreviewVisible?: () => void;
  showSkillsAndServices?: boolean;
  servesApp?: boolean;
}

export function ProjectView(props: ProjectViewProps) {
  const navigate = useNavigate();
  const jobDock = useJobDock();
  const { hasPermission } = usePermissions();
  const canViewCode = () => hasPermission('can_view_code_tab');
  const canViewDb = () => hasPermission('can_view_db_tab');
  const canManageUsers = () => props.servesApp !== false && hasPermission('can_manage_project_auth_settings');

  const [activeTab, setActiveTab] = createSignal<ProjectTab>('chat');
  const [visitedTabs, setVisitedTabs] = createSignal<Set<ProjectTab>>(new Set<ProjectTab>(['chat']));
  const [activeEnvironmentId, setActiveEnvironmentId] = createSignal(props.projectId);
  const [previewRequest, setPreviewRequest] = createSignal<FilePreviewRequest | null>(null);

  const previewFile = (path: string) => setPreviewRequest({ path });
  const closePreview = () => setPreviewRequest(null);
  const closePreviewOfDeleted = (deletedPath: string) => {
    const previewed = previewRequest()?.path;
    if (previewed && deletionCoversPath(deletedPath, previewed)) closePreview();
  };

  let closePreviewOverlay: () => void = () => {};
  const onCloseOverlayRef = (fn: () => void) => {
    closePreviewOverlay = fn;
  };
  let openPreviewOverlay: () => void = () => {};
  const onOpenOverlayRef = (fn: () => void) => {
    openPreviewOverlay = fn;
  };
  // On a phone the preview is a full-screen overlay reached from the bottom
  // bar, and the bar marks it as the current place while it is open.
  const { isMobile } = useSidebar();
  const [previewOverlayOpen, setPreviewOverlayOpen] = createSignal(false);

  const selectTab = (tab: ProjectTab) => {
    closePreviewOverlay();
    setActiveTab(tab);
    setVisitedTabs((prev) => (prev.has(tab) ? prev : new Set(prev).add(tab)));
  };
  const selectMobileDestination = (destination: ProjectMobileDestination) => {
    if (destination === 'preview') openPreviewOverlay();
    else selectTab(destination);
  };

  const projectId = () => props.projectId;
  const statusQuery = useProjectStatus(projectId, {
    enabled: () => activeTab() === 'chat' || props.onStatusEvent !== undefined,
    onEvent: () => props.onStatusEvent?.(),
  });
  const status = () => statusQuery.data?.status;

  const environments = useProjectEnvironments(projectId);
  const environmentList = () => environments.data ?? [];
  const activeEnvironment = createMemo(() => environmentList().find((e) => e.id === activeEnvironmentId()));
  const isDevelopmentActive = () => activeEnvironmentId() === props.projectId;

  const connectionStatus = () => (isDevelopmentActive() ? status() : activeEnvironment()?.status);

  createEffect(() => {
    if (props.projectId) {
      untrack(() => setActiveEnvironmentId(props.projectId));
    }
  });

  createEffect(() => {
    const list = environments.data;
    if (!list || environments.isFetching) return;
    const exists = list.some((e) => e.id === activeEnvironmentId());
    if (!exists) untrack(() => setActiveEnvironmentId(props.projectId));
  });

  createEffect(on(activeEnvironmentId, () => closePreview(), { defer: true }));

  createEffect(() => {
    if (isDevelopmentActive()) return;
    if (activeEnvironment()?.status !== 'suspended') return;
    fetch(`/api/proxy/${activeEnvironmentId()}/ping`).catch(() => {});
  });

  createEffect(() => {
    if (statusQuery.error instanceof ApiError && statusQuery.error.status === 404) {
      untrack(() => (props.onGone ? props.onGone() : navigate({ to: '/' })));
    }
  });

  const connection = useOpenCodeConnection({
    projectId: props.projectId,
    environmentId: activeEnvironmentId,
    status: connectionStatus,
    initialPrompt: () => props.initialPrompt(),
    onInitialPromptAdmitted: () => props.onInitialPromptAdmitted(),
  });
  const app = () => (props.servesApp === false ? undefined : statusQuery.data?.app);
  const previewVisible = () => app()?.exists === true || previewRequest() !== null;
  const fullWidthTab = () => activeTab() === 'users';
  const mobileTabs = (): ProjectTab[] => {
    const tabs: ProjectTab[] = ['chat', 'files'];
    if (connection.router() && canViewCode()) tabs.push('code');
    if (connection.router() && canViewDb()) tabs.push('db');
    if (canManageUsers()) tabs.push('users');
    return tabs;
  };

  createEffect(
    on([() => statusQuery.data !== undefined, previewVisible], ([loaded, visible], previous) => {
      const [wasLoaded, wasVisible] = previous ?? [false, false];
      if (loaded && wasLoaded && visible && !wasVisible) props.onPreviewVisible?.();
    })
  );

  const strip = usePaneStripSlot();
  const chatColumn = strip
    ? createResizablePanel({
        storageKey: `opsiforce:pane-strip:${strip.pane}-chat`,
        minWidth: () => Math.min(CHAT_COLUMN.min, strip.width()),
        defaultWidth: () => Math.min(CHAT_COLUMN.default, strip.width()),
        maxWidth: strip.width,
        direction: 'right',
      })
    : undefined;
  const contentFills = () => !strip || (strip.alone() && (!previewVisible() || fullWidthTab()));

  const [agentIdleToken, setAgentIdleToken] = createSignal(0);

  let reloadPreview: () => void = () => {};
  const onReloadRef = (fn: () => void) => {
    reloadPreview = fn;
  };

  onEnvironmentIdle(activeEnvironmentId, () => {
    reloadPreview();
    setAgentIdleToken((token) => token + 1);
  });

  onAppServing(activeEnvironmentId, () => reloadPreview());

  createEffect(() => {
    const unregister = jobDock.registerProjectView(props.projectId, {
      onPublishDone: (job) => {
        if (job.projectEnvironmentId === activeEnvironmentId()) reloadPreview();
      },
      viewEnvironment: (environmentId) => setActiveEnvironmentId(environmentId),
    });
    onCleanup(unregister);
  });

  return (
    <ProjectTabsContext.Provider value={{ openTab: selectTab }}>
      <div class={cn('h-full flex flex-col overflow-hidden', !strip && 'w-full')}>
        <div class={cn('flex shrink-0 flex-col', strip && 'w-0 min-w-full')}>
          <Show when={statusQuery.data}>
            {(data) => (
              <ProjectHeader
                projectId={props.projectId}
                status={data().status}
                workspaceId={data().workspaceId}
                appExists={!!data().app?.exists}
                showAgentTabs={!!connection.router()}
                showUsersTab={canManageUsers()}
                activeTab={activeTab()}
                onActiveTabChange={selectTab}
                environments={environmentList()}
                activeEnvironmentId={activeEnvironmentId()}
                onActiveEnvironmentChange={setActiveEnvironmentId}
                onDeleted={() => (props.onGone ? props.onGone() : navigate({ to: '/' }))}
                headerLabel={props.headerLabel}
                menuItems={props.menuItems}
                deleteDescription={props.deleteDescription}
                deleteEscapeHatch={props.deleteEscapeHatch}
                onRename={props.onRename}
              />
            )}
          </Show>

          <Show when={!isDevelopmentActive()}>
            <EnvProdBanner
              environmentName={activeEnvironment()?.name ?? 'this'}
              onSwitchToDevelopment={() => setActiveEnvironmentId(props.projectId)}
            />
          </Show>
        </div>

        {/* The content surface starts right under the band so the selected tab
          merges into it rather than floating on the canvas. */}
        <div class="relative flex-1 min-h-0 flex" style={{ background: 'var(--bg-content)' }}>
          <div
            class={cn('relative flex min-h-0', contentFills() ? 'flex-1 min-w-0' : 'shrink-0', strip && 'snap-start')}
            style={contentFills() || !chatColumn ? undefined : { width: `${chatColumn.width()}px` }}
          >
            <div
              class="flex-1 min-w-0 flex flex-col oc-chat-only"
              style={{ display: activeTab() === 'chat' ? 'flex' : 'none' }}
            >
              <Show when={connectionStatus() !== 'disabled'} fallback={<ProjectDisabled projectId={props.projectId} />}>
                <Show
                  when={connectionStatus() !== 'failed'}
                  fallback={<ProjectFailed projectId={props.projectId} environmentId={activeEnvironmentId()} />}
                >
                  <Show
                    when={connection.router()}
                    fallback={
                      <Show
                        when={connection.problem()}
                        fallback={
                          <ProjectConnecting
                            starting={connectionStatus() === 'starting' || connectionStatus() === 'suspended'}
                          />
                        }
                      >
                        {(problem) => (
                          <ProjectConnectionProblem
                            projectId={props.projectId}
                            environmentId={activeEnvironmentId()}
                            problem={problem()}
                            onRetry={connection.retry}
                          />
                        )}
                      </Show>
                    }
                  >
                    {(router) => (
                      <ProjectChatTab
                        projectId={props.projectId}
                        environmentId={activeEnvironmentId()}
                        environmentName={activeEnvironment()?.name ?? 'Development'}
                        showSkillsAndServices={props.showSkillsAndServices ?? true}
                        router={router()}
                        onPreviewFile={previewFile}
                      />
                    )}
                  </Show>
                </Show>
              </Show>
              {props.footer}
            </div>

            <Show when={visitedTabs().has('files')}>
              <div class="flex-1 min-w-0 flex flex-col" style={{ display: activeTab() === 'files' ? 'flex' : 'none' }}>
                <ProjectFilesTab
                  projectId={props.projectId}
                  environmentId={activeEnvironmentId()}
                  active={activeTab() === 'files'}
                  refreshToken={agentIdleToken()}
                  onPreviewFile={previewFile}
                  onFileDeleted={closePreviewOfDeleted}
                />
              </div>
            </Show>

            <Show when={visitedTabs().has('code') && canViewCode()}>
              <div class="flex-1 min-w-0 flex flex-col" style={{ display: activeTab() === 'code' ? 'flex' : 'none' }}>
                <ProjectCodeTab environmentId={activeEnvironmentId()} />
              </div>
            </Show>

            <Show when={visitedTabs().has('db') && canViewDb()}>
              <div class="flex-1 min-w-0 flex flex-col" style={{ display: activeTab() === 'db' ? 'flex' : 'none' }}>
                <ProjectDbTab environmentId={activeEnvironmentId()} />
              </div>
            </Show>

            <Show when={visitedTabs().has('users') && canManageUsers()}>
              <div class="flex-1 min-w-0 flex flex-col" style={{ display: activeTab() === 'users' ? 'flex' : 'none' }}>
                <ProjectUsersTab projectId={props.projectId} />
              </div>
            </Show>

            <Show when={!contentFills() && chatColumn}>
              {(column) => (
                <ResizeHandle
                  onPointerDown={column().startResize}
                  resizing={column().resizing()}
                  position="right"
                  panel={column()}
                  label="Resize this chat"
                />
              )}
            </Show>
          </div>

          <Show when={previewVisible()}>
            <div class="contents" style={{ display: fullWidthTab() && !isMobile() ? 'none' : 'contents' }}>
              <ProjectPreviewPanel
                projectId={props.projectId}
                environmentId={activeEnvironmentId()}
                publicUrl={activeEnvironment()?.publicUrl ?? null}
                hasApp={app()?.exists === true}
                appName={app()?.name ?? undefined}
                previewRequest={previewRequest()}
                onClosePreview={closePreview}
                onReloadRef={onReloadRef}
                onCloseOverlayRef={onCloseOverlayRef}
                onOpenOverlayRef={onOpenOverlayRef}
                onOverlayChange={setPreviewOverlayOpen}
                overlayBackLabel={`Back to ${PROJECT_TAB_LABELS[activeTab()]}`}
                mobile={isMobile()}
                column={
                  strip && {
                    storageKey: `opsiforce:pane-strip:${strip.pane}-preview`,
                    stripWidth: strip.width,
                  }
                }
              />
            </div>
          </Show>
        </div>

        <Show when={isMobile() && statusQuery.data}>
          <ProjectMobileNav
            active={previewOverlayOpen() && previewVisible() ? 'preview' : activeTab()}
            tabs={mobileTabs()}
            showPreview={previewVisible()}
            onSelect={selectMobileDestination}
          />
        </Show>
      </div>
    </ProjectTabsContext.Provider>
  );
}
