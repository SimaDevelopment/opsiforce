import { Show, createEffect, createSignal, on } from 'solid-js';
import { MarkedProvider } from '@opencode-ai/ui/context/marked';
import { PanelRightOpen } from '~/components/icons';
import { ResizeHandle } from '~/components/ui/resize-handle';
import { createResizablePanel } from '~/lib/create-resizable-panel';
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
}

export function ProjectPreviewPanel(props: ProjectPreviewPanelProps) {
  const [open, setOpen] = createSignal(true);
  const [mode, setMode] = createSignal<PreviewMode>('app');

  const panel = createResizablePanel({
    storageKey: 'opsiforce:preview-width',
    minWidth: 320,
    defaultWidth: () => Math.round(window.innerWidth * 0.4),
    maxWidth: () => window.innerWidth - 320,
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

  const fileMode = () => mode() === 'file' && previewPath() !== null;
  const switcher = () => (
    <Show when={props.hasApp && previewPath() !== null}>
      <PreviewModeSwitch mode={mode()} onChange={setMode} />
    </Show>
  );

  return (
    <MarkedProvider>
      <Show
        when={open()}
        fallback={
          <button
            onClick={() => setOpen(true)}
            class="shrink-0 w-9 bg-sidebar border-l border-border flex flex-col items-center justify-center gap-2 hover:bg-accent transition-colors"
            title={props.hasApp ? 'Show app preview' : 'Open panel'}
            aria-label={props.hasApp ? 'Show app preview' : 'Open panel'}
          >
            <PanelRightOpen class="w-4 h-4 text-muted-foreground" />
            <span class="text-xs text-muted-foreground [writing-mode:vertical-rl]">
              {props.hasApp ? 'App preview' : 'Open panel'}
            </span>
          </button>
        }
      >
        <div
          class="shrink-0 border-l border-border flex flex-col bg-background relative"
          style={{ width: `${panel.width()}px` }}
        >
          <ResizeHandle onPointerDown={panel.startResize} resizing={panel.resizing()} position="left" />

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
