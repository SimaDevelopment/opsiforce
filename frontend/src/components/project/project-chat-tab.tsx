import { Show, createMemo, createSignal, onCleanup, onMount, untrack, type Component } from 'solid-js';
import { render } from 'solid-js/web';
import type { BaseRouterProps } from '@solidjs/router';
import { AppBaseProviders, AppInterface, PlatformProvider, ServerConnection } from '@opencode/app';
import { useReachableModels } from '~/api/model-providers';
import { FileUpload } from '~/components/file-upload';
import { ExternalServicesButton } from './external-services/external-services-button';
import { SkillsButton } from './skills/skills-button';
import { DictationButton } from '~/components/dictation-button';
import { Spinner } from '~/components/ui/spinner';
import { WorkspaceFileLinks } from './workspace-file-links';
import { OpencodeOverrides } from './opencode-overrides';
import { createProxyPlatform } from './platform';

export interface ProjectChatTabProps {
  projectId: string;
  environmentId: string;
  environmentName: string;
  showSkillsAndServices: boolean;
  router: Component<BaseRouterProps>;
  onPreviewFile: (path: string) => void;
}

export function ProjectChatTab(props: ProjectChatTabProps) {
  const url = untrack(() => `${window.location.origin}/api/proxy/${props.environmentId}`);
  const server: ServerConnection.Http = { type: 'http', http: { url } };
  const platform = createProxyPlatform();
  const router = untrack(() => props.router);
  const reachableModelsQuery = useReachableModels();
  const reachableModels = createMemo<ReadonlySet<string> | undefined>(() => {
    const reachable = reachableModelsQuery.data;
    return reachable ? new Set(reachable) : undefined;
  });

  let embedHost!: HTMLDivElement;
  const host = () => embedHost;
  const [booting, setBooting] = createSignal(true);

  const coverBootUntilComposerPaints = () => {
    const composerPainted = () =>
      !!embedHost.querySelector(
        '[data-component="composer-editor"][contenteditable="true"], [contenteditable="true"], textarea'
      );
    const settle = () => {
      observer.disconnect();
      clearTimeout(maxTimer);
      requestAnimationFrame(() => requestAnimationFrame(() => setBooting(false)));
    };
    const check = () => {
      if (composerPainted()) settle();
    };
    const observer = new MutationObserver(check);
    observer.observe(embedHost, { childList: true, subtree: true });
    const maxTimer = setTimeout(settle, 15000);
    check();
    onCleanup(() => {
      observer.disconnect();
      clearTimeout(maxTimer);
    });
  };

  onMount(() => {
    let dispose: (() => void) | undefined;
    let disposed = false;
    const timer = setTimeout(() => {
      dispose = mountOpenCode();
      if (disposed) dispose();
    }, 0);
    coverBootUntilComposerPaints();
    onCleanup(() => {
      disposed = true;
      clearTimeout(timer);
      dispose?.();
    });
  });

  const mountOpenCode = () =>
    render(
      () => (
        <PlatformProvider value={platform}>
          <AppBaseProviders>
            <AppInterface servers={[server]} router={router}>
              <OpencodeOverrides server={server} reachableModels={reachableModels} />
            </AppInterface>
          </AppBaseProviders>
        </PlatformProvider>
      ),
      embedHost
    );

  return (
    <div class="relative flex-1 min-h-0 flex flex-col">
      <div ref={embedHost} class="contents" />
      <DictationButton projectId={props.projectId} environmentId={props.environmentId} host={host} />
      <FileUpload
        projectId={props.projectId}
        environmentId={props.environmentId}
        host={host}
        stripItems={
          <Show when={props.showSkillsAndServices}>
            <SkillsButton
              projectId={props.projectId}
              projectEnvironmentId={props.environmentId}
              environmentName={props.environmentName}
            />
            <ExternalServicesButton
              projectId={props.projectId}
              projectEnvironmentId={props.environmentId}
              environmentName={props.environmentName}
            />
          </Show>
        }
      />
      <WorkspaceFileLinks
        projectId={props.projectId}
        environmentId={props.environmentId}
        host={host}
        onPreviewFile={props.onPreviewFile}
      />
      <Show when={booting()}>
        <Spinner label="Connecting..." overlay />
      </Show>
    </div>
  );
}
