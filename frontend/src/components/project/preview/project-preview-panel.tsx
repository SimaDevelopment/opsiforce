import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  type Accessor,
  type JSX,
} from 'solid-js';
import { DialogProvider } from '@opencode/ui/context/dialog';
import { MarkedProvider } from '@opencode/ui/context/marked';
import { PanelRightOpen, PanelRightClose, X } from '~/components/icons';
import { ResizeHandle } from '~/components/ui/resize-handle';
import { createResizablePanel } from '~/lib/create-resizable-panel';
import { AppPreviewPane } from './app-preview-pane';
import { FilePreviewPane } from './file-preview-pane';
import { DesktopPreviewPane } from './desktop-preview-pane';
import { useDesktops } from '~/api/desktops';

export interface FilePreviewRequest {
  path: string;
}
export interface PreviewColumn {
  storageKey: string;
  stripWidth: Accessor<number>;
}
export interface ProjectPreviewPanelProps {
  projectId: string;
  environmentId: string;
  publicUrl: string | null;
  hasApp: boolean;
  appName?: string;
  previewRequest: FilePreviewRequest | null;
  onClosePreview: () => void;
  onReloadRef?: (reload: () => void) => void;
  onCloseOverlayRef?: (close: () => void) => void;
  overlayBackLabel: string;
  column?: PreviewColumn;
  desktopEnabled: boolean;
  onContentsChange: (visible: boolean) => void;
}
export const PROJECT_PANE_MIN_WIDTH = 640;

export function ProjectPreviewPanel(props: ProjectPreviewPanelProps) {
  const [files, setFiles] = createSignal<string[]>([]);
  const [windowViews, setWindowViews] = createSignal<string[]>([]);
  const [collapsed, setCollapsed] = createSignal<string[]>([]);
  const desktops = useDesktops(
    () => props.environmentId,
    () => props.desktopEnabled
  );
  const sessions = () => desktops.data ?? [];
  const sessionFor = (id: string) => sessions().find((s) => s.id === id.slice(8).split('/')[0]);
  const windowFor = (id: string) => id.slice(8).split('/')[1] || '';
  const ids = createMemo(() => [
    ...(props.hasApp ? ['app'] : []),
    ...files().map((path) => `file:${path}`),
    ...sessions()
      .filter((s) => s.visible)
      .map((s) => `desktop:${s.id}`),
    ...windowViews().filter((id) => sessionFor(id)?.windows.some((w) => w.id === windowFor(id))),
  ]);
  createEffect(() => props.onContentsChange(ids().length > 0));
  const label = (id: string) =>
    id === 'app'
      ? props.appName || 'App'
      : id.startsWith('file:')
        ? id.slice(5).split('/').pop() || 'File'
        : windowFor(id)
          ? sessionFor(id)?.windows.find((w) => w.id === windowFor(id))?.title || 'Window'
          : sessionFor(id)?.title || 'Desktop';
  function expand(id: string) {
    setCollapsed((current) => current.filter((item) => item !== id));
  }
  function openWindow(sessionId: string, window: string) {
    const id = `desktop:${sessionId}/${window}`;
    setWindowViews((current) => (current.includes(id) ? current : [...current, id]));
    expand(id);
  }
  function close(id: string) {
    if (id.startsWith('file:')) {
      setFiles((current) => current.filter((path) => `file:${path}` !== id));
      if (props.previewRequest?.path === id.slice(5)) props.onClosePreview();
    } else setWindowViews((current) => current.filter((item) => item !== id));
  }
  let presentations = new Map<string, number>();
  createEffect(
    on(
      () => props.environmentId,
      () => {
        presentations = new Map();
        setFiles([]);
        setWindowViews([]);
        setCollapsed([]);
      }
    )
  );
  createEffect(() => {
    for (const session of sessions()) {
      const previous = presentations.get(session.id);
      presentations.set(session.id, session.presentation);
      if (session.visible && session.presentation > 0 && previous !== session.presentation) {
        if (session.preferredWindow) openWindow(session.id, session.preferredWindow);
        else expand(`desktop:${session.id}`);
      }
    }
  });
  createEffect(
    on(
      () => props.previewRequest,
      (request) => {
        if (!request) return;
        setFiles((current) => (current.includes(request.path) ? current : [...current, request.path]));
        expand(`file:${request.path}`);
      }
    )
  );
  // There is no overlay now: each preview occupies an independent column.
  onMount(() => props.onCloseOverlayRef?.(() => {}));

  return (
    <DialogProvider>
      <MarkedProvider>
        <For each={ids()}>
          {(id) => (
            <PreviewColumnPane
              title={label(id)}
              storageKey={`${props.column?.storageKey || 'opsiforce:preview'}:${id}`}
              maxWidth={() => props.column?.stripWidth() || window.innerWidth}
              collapsed={collapsed().includes(id)}
              onCollapse={() => setCollapsed((current) => [...current, id])}
              onExpand={() => expand(id)}
              onClose={id.startsWith('file:') || windowFor(id) ? () => close(id) : undefined}
            >
              {(visible) => (
                <>
                  <Show when={id === 'app'}>
                    <AppPreviewPane
                      projectId={props.projectId}
                      environmentId={props.environmentId}
                      publicUrl={props.publicUrl}
                      appName={props.appName}
                      onReloadRef={props.onReloadRef}
                    />
                  </Show>
                  <Show when={id.startsWith('file:')}>
                    <FilePreviewPane
                      projectId={props.projectId}
                      environmentId={props.environmentId}
                      path={id.slice(5)}
                      onClose={() => close(id)}
                    />
                  </Show>
                  <Show when={id.startsWith('desktop:') && sessionFor(id)}>
                    {(session) => (
                      <DesktopPreviewPane
                        environmentId={props.environmentId}
                        session={session()}
                        visible={visible()}
                        windowId={windowFor(id)}
                        onOpenWindow={(window) => openWindow(session().id, window)}
                      />
                    )}
                  </Show>
                </>
              )}
            </PreviewColumnPane>
          )}
        </For>
      </MarkedProvider>
    </DialogProvider>
  );
}

function PreviewColumnPane(props: {
  title: string;
  storageKey: string;
  maxWidth: () => number;
  collapsed: boolean;
  onCollapse: () => void;
  onExpand: () => void;
  onClose?: () => void;
  children: (visible: Accessor<boolean>) => JSX.Element;
}) {
  const panel = createResizablePanel({
    storageKey: props.storageKey,
    minWidth: () => Math.min(320, props.maxWidth()),
    defaultWidth: () => Math.min(480, props.maxWidth()),
    maxWidth: props.maxWidth,
    direction: 'right',
  });
  const [inView, setInView] = createSignal(false);
  let element: HTMLElement | undefined;
  onMount(() => {
    const observer = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), { threshold: 0.01 });
    if (element) observer.observe(element);
    const frame = requestAnimationFrame(() => element?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
    onCleanup(() => cancelAnimationFrame(frame));
    onCleanup(() => observer.disconnect());
  });
  return (
    <section
      ref={element}
      aria-label={`${props.title} preview`}
      class="relative flex h-full shrink-0 snap-start flex-col border-l border-border bg-background"
      style={{ width: props.collapsed ? '36px' : `${panel.width()}px` }}
    >
      <Show
        when={props.collapsed}
        fallback={
          <div class="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-sidebar px-2">
            <span class="min-w-0 flex-1 truncate text-xs font-medium" title={props.title}>
              {props.title}
            </span>
            <button
              type="button"
              class="rounded p-1 hover:bg-accent"
              aria-label={`Collapse ${props.title}`}
              onClick={props.onCollapse}
            >
              <PanelRightClose class="h-3.5 w-3.5" />
            </button>
            <Show when={props.onClose}>
              {(close) => (
                <button
                  type="button"
                  class="rounded p-1 hover:bg-accent"
                  aria-label={`Close ${props.title}`}
                  onClick={close()}
                >
                  <X class="h-3.5 w-3.5" />
                </button>
              )}
            </Show>
          </div>
        }
      >
        <button
          type="button"
          class="flex h-full flex-col items-center justify-center gap-2 bg-sidebar hover:bg-accent"
          aria-label={`Expand ${props.title}`}
          onClick={props.onExpand}
        >
          <PanelRightOpen class="h-4 w-4" />
          <span class="text-xs [writing-mode:vertical-rl]">{props.title}</span>
        </button>
      </Show>
      <div class="min-h-0 flex-1 flex-col pr-1" style={{ display: props.collapsed ? 'none' : 'flex' }}>
        {props.children(() => !props.collapsed && inView())}
      </div>
      <Show when={!props.collapsed}>
        <ResizeHandle
          onPointerDown={panel.startResize}
          resizing={panel.resizing()}
          position="right"
          panel={panel}
          label={`Resize ${props.title}`}
        />
      </Show>
    </section>
  );
}
