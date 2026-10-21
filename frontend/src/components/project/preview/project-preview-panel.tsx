import { Show, createEffect, createSignal, on, onMount, type Accessor } from 'solid-js';
import { MarkedProvider } from '@opencode-ai/ui/context/marked';
import { ChevronLeft, PanelRightOpen } from '~/components/icons';
import { ResizeHandle } from '~/components/ui/resize-handle';
import { createElementWidth } from '~/lib/create-element-width';
import { createResizablePanel } from '~/lib/create-resizable-panel';
import { cn } from '~/lib/cn';
import { PREVIEW_COLUMN } from '~/lib/pane-widths';
import { AppPreviewPane } from './app-preview-pane';
import { FilePreviewPane } from './file-preview-pane';
import { PreviewModeSwitch, type PreviewMode } from './preview-mode-switch';

export interface FilePreviewRequest {
  path: string;
}

export interface ProjectPreviewPanelProps {
  projectId: string;
  environmentId: string;
  environmentSlug: string | null;
  hasApp: boolean;
  appName?: string;
  previewRequest: FilePreviewRequest | null;
  onClosePreview: () => void;
  onReloadRef?: (reload: () => void) => void;
  onCloseOverlayRef?: (close: () => void) => void;
  overlayBackLabel: string;
  column?: PreviewColumn;
}

export interface PreviewColumn {
  storageKey: string;
  stripWidth: Accessor<number>;
}

const MIN_PREVIEW_WIDTH = 320;
const MIN_CONTENT_WIDTH = 320;

export const PROJECT_PANE_MIN_WIDTH = MIN_PREVIEW_WIDTH + MIN_CONTENT_WIDTH;

export function ProjectPreviewPanel(props: ProjectPreviewPanelProps) {
  const [docked, setDocked] = createSignal(true);
  const [overlaid, setOverlaid] = createSignal(false);
  const [mode, setMode] = createSignal<PreviewMode>('app');

  let anchor: HTMLSpanElement | undefined;
  const containerWidth = createElementWidth(
    () => anchor?.parentElement,
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

  const fitsBesideContent = () => column !== undefined || containerWidth() >= PROJECT_PANE_MIN_WIDTH;
  const open = () => (fitsBesideContent() ? docked() : overlaid());
  const setOpen = (next: boolean) => (fitsBesideContent() ? setDocked(next) : setOverlaid(next));

  createEffect(on(fitsBesideContent, (fits) => fits && setOverlaid(false), { defer: true }));
  onMount(() => props.onCloseOverlayRef?.(() => setOverlaid(false)));

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

  const collapsedLabel = () => (props.hasApp ? 'Show app preview' : 'Open panel');

  const fileMode = () => mode() === 'file' && previewPath() !== null;
  const switcher = () => (
    <Show when={props.hasApp && previewPath() !== null}>
      <PreviewModeSwitch mode={mode()} onChange={setMode} />
    </Show>
  );

  return (
    <MarkedProvider>
      <span ref={anchor} hidden />
      <Show
        when={open()}
        fallback={
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
        }
      >
        <div
          class={cn(
            'flex flex-col bg-background',
            !fitsBesideContent()
              ? 'absolute inset-0 z-20'
              : cn('relative shrink-0 border-l border-border', column ? 'snap-start pr-2' : 'pl-2')
          )}
          style={fitsBesideContent() ? { width: `${panel.width()}px` } : undefined}
        >
          <Show
            when={fitsBesideContent()}
            fallback={
              <button
                type="button"
                onClick={() => setOverlaid(false)}
                class="flex h-10 shrink-0 items-center gap-1.5 border-b border-border px-3 text-sm font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <ChevronLeft class="h-4 w-4" />
                {props.overlayBackLabel}
              </button>
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
            <div class="flex-1 min-h-0 flex flex-col" style={{ display: fileMode() ? 'none' : 'flex' }}>
              <AppPreviewPane
                projectId={props.projectId}
                environmentId={props.environmentId}
                environmentSlug={props.environmentSlug}
                appName={props.appName}
                switcher={switcher()}
                onCollapse={fitsBesideContent() ? () => setDocked(false) : undefined}
                onReloadRef={props.onReloadRef}
              />
            </div>
          </Show>

          <Show when={previewPath()}>
            {(path) => (
              <div class="flex-1 min-h-0 flex flex-col" style={{ display: fileMode() ? 'flex' : 'none' }}>
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
        </div>
      </Show>
    </MarkedProvider>
  );
}
