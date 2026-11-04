import { Show, createEffect, createSignal, on, onCleanup, onMount, untrack, type JSX } from 'solid-js';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  ExternalLink,
  LoaderCircle,
  PanelRightClose,
  Pencil,
  RotateCw,
} from '~/components/icons';
import { Button } from '~/components/ui/button';
import { ToolbarButton } from '~/components/ui/toolbar-button';
import { usePermissions } from '~/api/permissions';
import { useProjectEnvironments } from '~/api/environments';
import { readableAppUrl } from '~/lib/app-url';
import { EditAppDialog } from '../edit-app-dialog';
import { EditAppUrlDialog } from '../edit-app-url-dialog';
import {
  previewLocationFrom,
  previewOrigin,
  sendPreviewCommand,
  typedPath,
  type PreviewLocation,
} from './preview-address';

export interface AppPreviewPaneProps {
  projectId: string;
  environmentId: string;
  publicUrl: string | null;
  appName?: string;
  switcher?: JSX.Element;
  onCollapse?: () => void;
  onReloadRef?: (reload: () => void) => void;
}

export function AppPreviewPane(props: AppPreviewPaneProps) {
  const [iframeLoading, setIframeLoading] = createSignal(true);
  const [copied, setCopied] = createSignal(false);
  const [editAppOpen, setEditAppOpen] = createSignal(false);
  const [editUrlOpen, setEditUrlOpen] = createSignal(false);

  const { hasPermission } = usePermissions();
  const canEditAppDetails = () => hasPermission('can_edit_app_details');
  const environments = useProjectEnvironments(() => props.projectId, { enabled: canEditAppDetails });
  const activeEnv = () => environments.data?.find((e) => e.id === props.environmentId);
  const showEditAction = () => canEditAppDetails() && activeEnv()?.hasApp === true;
  const readableAddressOnOffer = () => {
    const env = activeEnv();
    return showEditAction() && env && !env.appSlug && env.suggestedAppSlug
      ? readableAppUrl(env.suggestedAppSlug, env)
      : null;
  };

  const origin = () => previewOrigin(props.environmentId);
  const [framePath, setFramePath] = createSignal('/');
  const [location, setLocation] = createSignal<PreviewLocation | null>(null);
  const [draft, setDraft] = createSignal<string | null>(null);
  const currentPath = () => location()?.path ?? framePath();
  const publicHost = () => (props.publicUrl ? new URL(props.publicUrl).host : null);
  const publicAddress = () => (props.publicUrl ? new URL(currentPath(), props.publicUrl).href : null);

  let iframeRef: HTMLIFrameElement | undefined;
  let reportsSinceLoad = 0;
  let frameReports = false;

  createEffect(
    on(
      () => props.environmentId,
      () => {
        frameReports = false;
        setDraft(null);
        load('/');
      },
      { defer: true }
    )
  );

  function onMessage(event: MessageEvent) {
    const frame = iframeRef;
    const reported = frame && previewLocationFrom(event, frame, origin());
    if (!reported) return;
    reportsSinceLoad += 1;
    frameReports = true;
    setLocation(reported);
  }

  function onFrameLoad() {
    frameReports = reportsSinceLoad > 0;
    reportsSinceLoad = 0;
    setIframeLoading(false);
  }

  function load(path: string) {
    if (!iframeRef) return;
    setIframeLoading(true);
    setLocation(null);
    setFramePath(path);
    iframeRef.src = `${origin()}${path}`;
  }

  function reload() {
    const frame = iframeRef;
    if (!frame) return;
    if (frameReports) {
      setIframeLoading(true);
      sendPreviewCommand(frame, origin(), 'reload');
    } else {
      load(currentPath());
    }
  }

  function traverse(direction: 'back' | 'forward') {
    if (iframeRef) sendPreviewCommand(iframeRef, origin(), direction);
  }

  function submitAddress(input: HTMLInputElement) {
    const knownHosts = [new URL(origin()).host, publicHost()].filter((host) => host !== null);
    load(typedPath(input.value, knownHosts));
    setDraft(null);
    input.blur();
  }

  function copyAddress(address: string) {
    navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  onMount(() => {
    window.addEventListener('message', onMessage);
    props.onReloadRef?.(reload);
  });
  onCleanup(() => window.removeEventListener('message', onMessage));

  return (
    <>
      <div class="h-8 flex items-center gap-2 px-1.5 bg-sidebar border-b border-border shrink-0">
        <div class="flex flex-1 min-w-0 items-center gap-1">
          <Show when={props.onCollapse}>
            {(collapse) => (
              <ToolbarButton onClick={collapse()} tooltip="Close panel">
                <PanelRightClose class="w-3.5 h-3.5" />
              </ToolbarButton>
            )}
          </Show>
          <span class="text-xs font-medium text-muted-foreground truncate">
            {activeEnv()?.appName || props.appName || 'App'}
          </span>
          <Show when={showEditAction()}>
            <ToolbarButton onClick={() => setEditAppOpen(true)} tooltip="Edit app details">
              <Pencil class="w-3 h-3" />
            </ToolbarButton>
          </Show>
        </div>
        {props.switcher}
        <div class="flex flex-1 items-center justify-end gap-0.5">
          <Show when={publicAddress()}>
            {(address) => (
              <>
                <ToolbarButton onClick={() => copyAddress(address())} tooltip={copied() ? 'Copied!' : 'Copy URL'}>
                  {copied() ? <Check class="w-3.5 h-3.5 text-green-500" /> : <Copy class="w-3.5 h-3.5" />}
                </ToolbarButton>
                <a
                  href={address()}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Open app in a new tab"
                  title="Open app in a new tab"
                  class="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <ExternalLink class="w-3.5 h-3.5" />
                </a>
                <Show when={showEditAction() && !readableAddressOnOffer()}>
                  <ToolbarButton onClick={() => setEditUrlOpen(true)} tooltip="Edit URL">
                    <Pencil class="w-3 h-3" />
                  </ToolbarButton>
                </Show>
              </>
            )}
          </Show>
        </div>
      </div>
      <div class="flex items-center gap-0.5 px-1.5 py-1 bg-sidebar border-b border-border shrink-0">
        <ToolbarButton onClick={() => traverse('back')} disabled={!location()?.canGoBack} tooltip="Back">
          <ArrowLeft class="w-3.5 h-3.5" />
        </ToolbarButton>
        <ToolbarButton onClick={() => traverse('forward')} disabled={!location()?.canGoForward} tooltip="Forward">
          <ArrowRight class="w-3.5 h-3.5" />
        </ToolbarButton>
        <ToolbarButton onClick={reload} tooltip="Reload app">
          <Show when={iframeLoading()} fallback={<RotateCw class="w-3.5 h-3.5" />}>
            <LoaderCircle class="w-3.5 h-3.5 animate-spin" />
          </Show>
        </ToolbarButton>
        <label class="mx-1 flex h-6 min-w-0 flex-1 items-center rounded-md border border-input bg-background px-2 text-xs focus-within:ring-1 focus-within:ring-ring">
          <Show when={draft() === null && publicHost()}>
            {(host) => <span class="min-w-0 shrink-[4] truncate text-muted-foreground">{host()}</span>}
          </Show>
          <input
            aria-label="App address"
            type="text"
            spellcheck={false}
            autocomplete="off"
            value={draft() ?? currentPath()}
            title={publicAddress() ?? currentPath()}
            onFocus={(event) => {
              setDraft(publicAddress() ?? currentPath());
              event.currentTarget.select();
            }}
            onInput={(event) => setDraft(event.currentTarget.value)}
            onBlur={() => setDraft(null)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submitAddress(event.currentTarget);
              if (event.key === 'Escape') event.currentTarget.blur();
            }}
            class="min-w-20 flex-auto bg-transparent text-foreground outline-none [field-sizing:content]"
          />
        </label>
      </div>
      <Show when={readableAddressOnOffer()}>
        {(address) => (
          <div class="flex items-center gap-2 px-2 py-1.5 bg-sidebar border-b border-border shrink-0 text-xs">
            <span class="min-w-0 flex-1 truncate text-muted-foreground">
              Readable address available: <span class="text-foreground">{address()}</span>
            </span>
            <Button size="sm" variant="outline" class="h-6 shrink-0 px-2 text-xs" onClick={() => setEditUrlOpen(true)}>
              Switch
            </Button>
          </div>
        )}
      </Show>
      <div class="flex-1 min-h-0">
        <iframe
          ref={iframeRef}
          src={untrack(() => `${origin()}/`)}
          title="App preview"
          class="w-full h-full border-0"
          allow="microphone; camera; clipboard-read; clipboard-write; geolocation; fullscreen; autoplay; display-capture; web-share"
          onLoad={onFrameLoad}
          onError={() => setIframeLoading(false)}
        />
      </div>
      <EditAppDialog
        projectId={props.projectId}
        environmentId={props.environmentId}
        open={editAppOpen()}
        onOpenChange={setEditAppOpen}
        initialName={activeEnv()?.appName ?? props.appName ?? null}
        initialDescription={activeEnv()?.appDescription ?? null}
      />
      <EditAppUrlDialog
        projectId={props.projectId}
        environment={editUrlOpen() ? (activeEnv() ?? null) : null}
        onOpenChange={setEditUrlOpen}
      />
    </>
  );
}
