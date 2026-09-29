import { Show, createEffect, createSignal, on, type Accessor } from 'solid-js';
import { MarkedProvider } from '@opencode-ai/ui/context/marked';
import { PanelRightOpen } from '~/components/icons';
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
  const [open, setOpen] = createSignal(true);
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

  createEffect(
    on(
      () => props.previewRequest,
      (request) => {
        if (request === null) {
          setMode('app');
          return;
        }
        setMode('file');
        setOpen(true);
      }
    )
  );

  const fitsBesideContent = () => column !== undefined || containerWidth() >= PROJECT_PANE_MIN_WIDTH;

  const collapsedLabel = () => {
    if (!fitsBesideContent()) return 'Widen this pane to show the preview';
    return props.hasApp ? 'Show app preview' : 'Open panel';
  };

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
        when={open() && fitsBesideContent()}
        fallback={
          <button
            onClick={() => setOpen(true)}
            disabled={!fitsBesideContent()}
            class={cn(
              'shrink-0 w-9 bg-sidebar border-l border-border flex flex-col items-center justify-center gap-2 hover:bg-accent transition-colors disabled:cursor-default disabled:hover:bg-sidebar',
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
            'shrink-0 border-l border-border flex flex-col bg-background relative',
            column ? 'snap-start pr-2' : 'pl-2'
          )}
          style={{ width: `${panel.width()}px` }}
        >
          <ResizeHandle
            onPointerDown={panel.startResize}
            resizing={panel.resizing()}
            position={column ? 'right' : 'left'}
            panel={panel}
            label="Resize the preview"
          />

          <Show when={props.hasApp}>
            <div class="flex-1 min-h-0 flex flex-col" style={{ display: fileMode() ? 'none' : 'flex' }}>
              <AppPreviewPane
                projectId={props.projectId}
                environmentId={props.environmentId}
                environmentSlug={props.environmentSlug}
                appName={props.appName}
                switcher={switcher()}
                onCollapse={() => setOpen(false)}
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
