import { Show, createSignal, onCleanup, onMount, untrack, type Component } from 'solid-js';
import { render } from 'solid-js/web';
import type { BaseRouterProps } from '@solidjs/router';
import { AppBaseProviders, AppInterface, PlatformProvider, ServerConnection } from '@opencode-ai/app';
import { useGlobal } from '@opencode-ai/app/runtime/server/runtime';
import { useSyncProjectTitle } from '~/api/projects';
import { FileUpload } from '~/components/file-upload';
import { DictationButton } from '~/components/dictation-button';
import { Spinner } from '~/components/ui/spinner';
import { WorkspaceFileLinks } from './workspace-file-links';
import { OpencodeOverrides } from './opencode-overrides';
import { createProxyPlatform } from './platform';

function OpenCodeEventBridge(props: {
  server: ServerConnection.Any;
  onIdle: () => void;
  onTitle: (title: string) => void;
}) {
  const global = useGlobal();
  const ctx = untrack(() => global.ensureServerCtx(props.server));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unsubIdle = ctx.sdk.event.on('session.status', (event) => {
    if (event.data.status.type !== 'idle') return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => props.onIdle(), 1500);
  });
  const unsubTitle = ctx.sdk.event.on('session.renamed', (event) => {
    if (ctx.data.session.get(event.data.sessionID)?.parentID) return;
    props.onTitle(event.data.title);
  });
  onCleanup(() => {
    unsubIdle();
    unsubTitle();
    if (timer) clearTimeout(timer);
  });
  return null;
}

export interface ProjectChatTabProps {
  projectId: string;
  environmentId: string;
  router: Component<BaseRouterProps>;
  currentTitle: string | null;
  onAgentIdle: () => void;
  onPreviewFile: (path: string) => void;
}

export function ProjectChatTab(props: ProjectChatTabProps) {
  const syncTitle = useSyncProjectTitle();
  const url = untrack(() => `${window.location.origin}/api/proxy/${props.environmentId}`);
  const server: ServerConnection.Http = { type: 'http', http: { url } };
  const serverKey = ServerConnection.Key.make(url);
  const platform = createProxyPlatform(url);
  const router = untrack(() => props.router);
  const onTitle = (title: string) => syncTitle(props.projectId, title, props.currentTitle);

  let embedHost!: HTMLDivElement;
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
            <AppInterface defaultServer={serverKey} servers={[server]} router={router}>
              <OpencodeOverrides server={server} />
              <OpenCodeEventBridge server={server} onIdle={() => props.onAgentIdle()} onTitle={onTitle} />
            </AppInterface>
          </AppBaseProviders>
        </PlatformProvider>
      ),
      embedHost
    );

  return (
    <div class="relative flex-1 min-h-0 flex flex-col">
      <div ref={embedHost} class="contents" />
      <DictationButton projectId={props.projectId} environmentId={props.environmentId} />
      <FileUpload projectId={props.projectId} environmentId={props.environmentId} />
      <WorkspaceFileLinks
        projectId={props.projectId}
        environmentId={props.environmentId}
        onPreviewFile={props.onPreviewFile}
      />
      <Show when={booting()}>
        <Spinner label="Connecting..." overlay />
      </Show>
    </div>
  );
}
