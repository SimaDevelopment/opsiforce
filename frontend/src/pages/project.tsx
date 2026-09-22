import { Button } from '~/components/ui/button';
import { Show, createEffect, createMemo, createSignal, on, onCleanup, untrack } from 'solid-js';
import { useNavigate } from '@tanstack/solid-router';
import { usePermissions } from '~/api/permissions';
import { Permission } from '~/constants/permissions';
import { ApiError } from '~/api/client';
import { useProjectStatus } from '~/api/projects';
import { useProjectEnvironments } from '~/api/environments';
import { deletionCoversPath } from '~/api/files';
import { Spinner } from '~/components/ui/spinner';
import { ProjectHeader, type ProjectTab } from '~/components/project/project-header';
import { ProjectChatTab } from '~/components/project/project-chat-tab';
import { ProjectCodeTab } from '~/components/project/project-code-tab';
import { ProjectDbTab } from '~/components/project/project-db-tab';
import { ProjectFilesTab } from '~/components/project/files';
import { ProjectPreviewPanel, type FilePreviewRequest } from '~/components/project/preview';
import { ProjectDisabled } from '~/components/project/project-disabled';
import { ProjectFailed } from '~/components/project/project-failed';
import { EnvProdBanner } from '~/components/project/environments/env-prod-banner';
import { useJobDock } from '~/components/project/jobs/job-dock-context';
import { useOpenCodeConnection, type InitialPrompt } from '~/components/project/use-opencode-connection';

export function ProjectView(props: {
  projectId: string;
  initialPrompt: () => InitialPrompt | undefined;
  onInitialPromptAdmitted: () => void;
}) {
  const navigate = useNavigate();
  const jobDock = useJobDock();
  const { hasPermission } = usePermissions();
  const canViewCode = () => hasPermission(Permission.viewCodeTab);
  const canViewDb = () => hasPermission(Permission.viewDbTab);

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

  const selectTab = (tab: ProjectTab) => {
    setActiveTab(tab);
    setVisitedTabs((prev) => (prev.has(tab) ? prev : new Set(prev).add(tab)));
  };

  const projectId = () => props.projectId;
  const statusQuery = useProjectStatus(projectId, {
    enabled: () => activeTab() === 'chat',
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
      untrack(() => navigate({ to: '/' }));
    }
  });

  const connection = useOpenCodeConnection({
    projectId: props.projectId,
    environmentId: activeEnvironmentId,
    status: connectionStatus,
    currentTitle: () => statusQuery.data?.title,
    initialPrompt: () => props.initialPrompt(),
    onInitialPromptAdmitted: () => props.onInitialPromptAdmitted(),
  });
  const app = () => statusQuery.data?.app;

  const [agentIdleToken, setAgentIdleToken] = createSignal(0);

  let reloadPreview: () => void = () => {};
  const onReloadRef = (fn: () => void) => {
    reloadPreview = fn;
  };

  const handleAgentIdle = () => {
    reloadPreview();
    setAgentIdleToken((token) => token + 1);
  };

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
    <div class="h-full w-full flex flex-col overflow-hidden">
      <Show when={statusQuery.data}>
        {(data) => (
          <ProjectHeader
            projectId={props.projectId}
            status={data().status}
            workspaceId={data().workspaceId}
            appExists={!!data().app?.exists}
            showAgentTabs={!!connection.router()}
            activeTab={activeTab()}
            onActiveTabChange={selectTab}
            environments={environmentList()}
            activeEnvironmentId={activeEnvironmentId()}
            onActiveEnvironmentChange={setActiveEnvironmentId}
            onDeleted={() => navigate({ to: '/' })}
          />
        )}
      </Show>

      <Show when={!isDevelopmentActive()}>
        <EnvProdBanner
          environmentName={activeEnvironment()?.name ?? 'this'}
          onSwitchToDevelopment={() => setActiveEnvironmentId(props.projectId)}
        />
      </Show>

      <div class="flex-1 min-h-0 flex">
        <div
          class="flex-1 min-w-0 flex flex-col oc-chat-only"
          style={{ display: activeTab() === 'chat' ? 'flex' : 'none' }}
        >
          <Show when={connectionStatus() !== 'disabled'} fallback={<ProjectDisabled projectId={props.projectId} />}>
            <Show when={connectionStatus() !== 'failed'} fallback={<ProjectFailed projectId={props.projectId} />}>
              <Show
                when={connection.router()}
                fallback={
                  <Show when={connection.error()} fallback={<Spinner label="Connecting..." />}>
                    {(message) => (
                      <div class="flex flex-col items-center justify-center gap-3 p-6" role="alert">
                        <p>{message()}</p>
                        <Button onClick={connection.retry}>Retry</Button>
                      </div>
                    )}
                  </Show>
                }
              >
                {(router) => (
                  <ProjectChatTab
                    projectId={props.projectId}
                    environmentId={activeEnvironmentId()}
                    router={router()}
                    currentTitle={statusQuery.data?.title ?? null}
                    onAgentIdle={handleAgentIdle}
                    onPreviewFile={previewFile}
                  />
                )}
              </Show>
            </Show>
          </Show>
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

        <Show when={app()?.exists === true || previewRequest() !== null}>
          <ProjectPreviewPanel
            projectId={props.projectId}
            environmentId={activeEnvironmentId()}
            environmentSlug={activeEnvironment()?.slug ?? null}
            hasApp={app()?.exists === true}
            appName={app()?.name ?? undefined}
            previewRequest={previewRequest()}
            onClosePreview={closePreview}
            onReloadRef={onReloadRef}
          />
        </Show>
      </div>
    </div>
  );
}
