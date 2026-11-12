import { Show, createEffect, createSignal, on, onCleanup, onMount, type Accessor } from 'solid-js';
import { DialogProvider } from '@opencode/ui/context/dialog';
import { MarkedProvider } from '@opencode/ui/context/marked';
import { ChevronLeft, PanelRightOpen } from '~/components/icons';
import { ResizeHandle } from '~/components/ui/resize-handle';
import { createElementWidth } from '~/lib/create-element-width';
import { createResizablePanel } from '~/lib/create-resizable-panel';
import { cn } from '~/lib/cn';
import { PREVIEW_COLUMN } from '~/lib/pane-widths';
import { AppPreviewPane } from './app-preview-pane';
import { FilePreviewPane } from './file-preview-pane';
import { DesktopPreviewPane } from './desktop-preview-pane';
import { PreviewModeSwitch, type PreviewMode } from './preview-mode-switch';
import { isAgentWaiting, isAgentWorking } from '~/api/agent-status';
import { stopAgent, type DesktopSession } from '~/api/desktops';

export interface FilePreviewRequest {
  path: string;
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
  /** Lets the phone's bottom bar open the overlay, the way a tab is opened. */
  onOpenOverlayRef?: (open: () => void) => void;
  /** Reports the overlay's state, so the bottom bar can mark Preview as current. */
  onOverlayChange?: (open: boolean) => void;
  overlayBackLabel: string;
  /** On a phone the bottom bar is the way in and out: no side rail, no Back row. */
  mobile?: boolean;
  column?: PreviewColumn;
  /** The chat session the person has open, which Stop the agent interrupts. */
  chatSessionId?: string;
  /** The pod's desktop, shown as a third mode once it has a window or the agent presents it. */
  desktop?: DesktopSession;
  /** True once for each `desktop show` the panel has not opened for yet. */
  takeDesktopShow?: () => boolean;
  /** The page is showing a tab that hides the panel, so nothing in it should stay connected. */
  hidden?: boolean;
}

export interface PreviewColumn {
  storageKey: string;
  stripWidth: Accessor<number>;
}

const BROWSER_APPS = new Set(['chromium', 'chromium-browser', 'google-chrome', 'firefox']);
const MIN_PREVIEW_WIDTH = 320;
const MIN_CONTENT_WIDTH = 320;

export const PROJECT_PANE_MIN_WIDTH = MIN_PREVIEW_WIDTH + MIN_CONTENT_WIDTH;

function layoutParent(element: Element | undefined) {
  let parent = element?.parentElement;
  while (parent && getComputedStyle(parent).display === 'contents') parent = parent.parentElement;
  return parent;
}

export function ProjectPreviewPanel(props: ProjectPreviewPanelProps) {
  const [docked, setDocked] = createSignal(true);
  const [overlaid, setOverlaid] = createSignal(false);
  const [mode, setMode] = createSignal<PreviewMode>('app');

  let anchor: HTMLSpanElement | undefined;
  const containerWidth = createElementWidth(
    () => layoutParent(anchor),
    typeof window === 'undefined' ? PROJECT_PANE_MIN_WIDTH : window.innerWidth
  );

  const column = props.column;
  const panel = column
    ? createResizablePanel({
        storageKey: column.storageKey,
        minWidth: () => Math.min(PREVIEW_COLUMN.min, column.stripWidth()),
        defaultWidth: () => Math.min(PREVIEW_COLUMN.default, column.stripWidth()),
        maxWidth: column.stripWidth,
        direction: 'right',
      })
    : createResizablePanel({
        storageKey: 'opsiforce:preview-width',
        minWidth: MIN_PREVIEW_WIDTH,
        defaultWidth: () => Math.round(containerWidth() * 0.4),
        maxWidth: () => containerWidth() - MIN_CONTENT_WIDTH,
        direction: 'left',
      });

  const previewPath = () => props.previewRequest?.path ?? null;
  const desktop = () => (props.desktop?.visible ? props.desktop : undefined);
  const [desktopWindow, setDesktopWindow] = createSignal('');
  const desktopLabel = () =>
    desktop()?.windows.every((window) => BROWSER_APPS.has(window.app.toLowerCase())) ? 'Browser' : 'Screen';

  const modes = (): PreviewMode[] => [
    ...(props.hasApp ? (['app'] as const) : []),
    ...(previewPath() !== null ? (['file'] as const) : []),
    ...(desktop() ? (['desktop'] as const) : []),
  ];
  const current = (): PreviewMode => (modes().includes(mode()) ? mode() : (modes()[0] ?? 'app'));

  // On a phone the preview is always the overlay the bottom bar opens and
  // closes, whatever the width or the pane strip would allow: a docked column
  // at 640-767px, or in a Builder's strip, is one the bar cannot mark or close.
  const fitsBesideContent = () => !props.mobile && (column !== undefined || containerWidth() >= PROJECT_PANE_MIN_WIDTH);
  const open = () => (fitsBesideContent() ? docked() : overlaid());
  const setOpen = (next: boolean) => (fitsBesideContent() ? setDocked(next) : setOverlaid(next));
  const [opened, setOpened] = createSignal(false);
  createEffect(() => open() && setOpened(true));

  createEffect(on(fitsBesideContent, (fits) => fits && setOverlaid(false), { defer: true }));
  onMount(() => props.onCloseOverlayRef?.(() => setOverlaid(false)));
  onMount(() => props.onOpenOverlayRef?.(() => setOverlaid(true)));
  createEffect(() => props.onOverlayChange?.(overlaid()));
  // The panel unmounts when nothing is left to show (a closed file in a project
  // with no App yet); the bar must not keep marking Preview as current.
  onCleanup(() => props.onOverlayChange?.(false));

  createEffect(
    on(
      () => props.previewRequest,
      (request) => {
        if (request === null) {
          setMode('app');
          setOverlaid(false);
          return;
        }
        setMode('file');
        setOpen(true);
      }
    )
  );

  createEffect(
    on(
      () => props.desktop?.shows ?? 0,
      () => {
        const session = props.desktop;
        if (!props.takeDesktopShow?.() || !session?.visible) return;
        setDesktopWindow(session.preferredWindow);
        setMode('desktop');
        setOpen(true);
      }
    )
  );

  const collapsedLabel = () => (props.hasApp ? 'Show app preview' : 'Open panel');

  const switcher = () => (
    <Show when={modes().length > 1}>
      <PreviewModeSwitch modes={modes()} mode={current()} onChange={setMode} labels={{ desktop: desktopLabel() }} />
    </Show>
  );
  const onCollapse = () => (fitsBesideContent() ? () => setDocked(false) : undefined);

  return (
    <DialogProvider>
      <MarkedProvider>
        <span ref={anchor} hidden />
        <Show when={!open() && !props.mobile}>
          <button
            onClick={() => setOpen(true)}
            class={cn(
              'shrink-0 w-9 bg-sidebar border-l border-border flex flex-col items-center justify-center gap-2 hover:bg-accent transition-colors',
              column && 'snap-start'
            )}
            title={collapsedLabel()}
            aria-label={collapsedLabel()}
          >
            <PanelRightOpen class="w-4 h-4 text-muted-foreground" />
            <span class="text-xs text-muted-foreground [writing-mode:vertical-rl]">
              {props.hasApp ? 'App preview' : 'Open panel'}
            </span>
          </button>
        </Show>
        <Show when={opened()}>
          <div
            class={cn(
              'flex flex-col bg-background',
              !fitsBesideContent()
                ? 'absolute inset-0 z-20'
                : cn('relative shrink-0 border-l border-border', column ? 'snap-start pr-2' : 'pl-2')
            )}
            style={{
              display: open() ? undefined : 'none',
              width: fitsBesideContent() ? `${panel.width()}px` : undefined,
            }}
          >
            <Show
              when={fitsBesideContent()}
              fallback={
                <Show when={!props.mobile}>
                  <button
                    type="button"
                    onClick={() => setOverlaid(false)}
                    class="flex h-10 shrink-0 items-center gap-1.5 border-b border-border px-3 text-sm font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    <ChevronLeft class="h-4 w-4" />
                    {props.overlayBackLabel}
                  </button>
                </Show>
              }
            >
              <ResizeHandle
                onPointerDown={panel.startResize}
                resizing={panel.resizing()}
                position={column ? 'right' : 'left'}
                panel={panel}
                label="Resize the preview"
              />
            </Show>

            <Show when={props.hasApp}>
              <div class="flex-1 min-h-0 flex flex-col" style={{ display: current() === 'app' ? 'flex' : 'none' }}>
                <AppPreviewPane
                  projectId={props.projectId}
                  environmentId={props.environmentId}
                  publicUrl={props.publicUrl}
                  appName={props.appName}
                  switcher={switcher()}
                  onCollapse={onCollapse()}
                  onReloadRef={props.onReloadRef}
                />
              </div>
            </Show>

            <Show when={previewPath()}>
              {(path) => (
                <div class="flex-1 min-h-0 flex flex-col" style={{ display: current() === 'file' ? 'flex' : 'none' }}>
                  <FilePreviewPane
                    projectId={props.projectId}
                    environmentId={props.environmentId}
                    path={path()}
                    switcher={switcher()}
                    onClose={props.onClosePreview}
                  />
                </div>
              )}
            </Show>

            <Show when={desktop()}>
              {(session) => (
                <div
                  class="flex-1 min-h-0 flex flex-col"
                  style={{ display: current() === 'desktop' ? 'flex' : 'none' }}
                >
                  <DesktopPreviewPane
                    environmentId={props.environmentId}
                    session={session()}
                    visible={open() && current() === 'desktop' && !props.mobile && !props.hidden}
                    windowId={desktopWindow()}
                    onSelectWindow={setDesktopWindow}
                    switcher={switcher()}
                    onCollapse={onCollapse()}
                    agentWorking={isAgentWorking(props.projectId) && !isAgentWaiting(props.projectId)}
                    onStopAgent={() => stopAgent(props.environmentId, props.chatSessionId)}
                    mobile={props.mobile === true}
                  />
                </div>
              )}
            </Show>
          </div>
        </Show>
      </MarkedProvider>
    </DialogProvider>
  );
}
