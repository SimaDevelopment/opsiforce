import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, type JSX } from 'solid-js';
import type RFB from '@novnc/novnc';
import { desktopBase, type DesktopSession } from '~/api/desktops';
import { ClipboardPaste, Maximize2, Minimize2, PanelRightClose } from '~/components/icons';
import { Button } from '~/components/ui/button';
import { ToolbarButton } from '~/components/ui/toolbar-button';

const MAX_RECONNECTS = 8;
const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'AltGraph', 'Meta', 'CapsLock']);
const NAMED_KEYSYMS: Record<string, number> = {
  Tab: 0xff09,
  Enter: 0xff0d,
  Escape: 0xff1b,
  Backspace: 0xff08,
  Delete: 0xffff,
  Insert: 0xff63,
  Home: 0xff50,
  End: 0xff57,
  PageUp: 0xff55,
  PageDown: 0xff56,
  ArrowLeft: 0xff51,
  ArrowUp: 0xff52,
  ArrowRight: 0xff53,
  ArrowDown: 0xff54,
  ' ': 0x20,
};

/** The layout's own letter, or the physical key's when the layout types a non-Latin character there. */
function latinLetterOf(event: KeyboardEvent): string | undefined {
  const key = event.key.toLowerCase();
  if (/^[a-z]$/.test(key)) return key;
  return /^Key[A-Z]$/.test(event.code) ? event.code.slice(3).toLowerCase() : undefined;
}

function keysymOf(event: KeyboardEvent): number | undefined {
  const named = NAMED_KEYSYMS[event.key];
  if (named !== undefined) return named;
  const fn = /^F([1-9]|1[0-2])$/.exec(event.key);
  if (fn) return 0xffbe + Number(fn[1]) - 1;
  const letter = latinLetterOf(event);
  if (letter) return letter.charCodeAt(0);
  if (/^[0-9]$/.test(event.key)) return event.key.charCodeAt(0);
  if (/^Digit[0-9]$/.test(event.code)) return event.code.charCodeAt(5);
  const point = [...event.key].length === 1 ? event.key.toLowerCase().codePointAt(0) : undefined;
  if (point === undefined) return undefined;
  return point <= 0xff ? point : 0x01000000 + point;
}

function letterOf(event: KeyboardEvent) {
  return latinLetterOf(event) ?? event.key.toLowerCase();
}

function typesACharacter(event: KeyboardEvent) {
  if (event.getModifierState('AltGraph')) return true;
  return event.altKey && !event.ctrlKey && !event.metaKey && /Mac|iPhone|iPad/.test(navigator.platform);
}

export interface DesktopPreviewPaneProps {
  environmentId: string;
  session: DesktopSession;
  visible: boolean;
  /** The window to show on its own, or '' for the whole desktop. */
  windowId: string;
  onSelectWindow: (window: string) => void;
  switcher?: JSX.Element;
  onCollapse?: () => void;
  /** A phone cannot show the screen at a usable size. */
  mobile: boolean;
  /** The Project's Agent is running, so it may be using this screen at the same time. */
  agentWorking: boolean;
  onStopAgent: () => Promise<void>;
}

export function DesktopPreviewPane(props: DesktopPreviewPaneProps) {
  const selectedWindow = createMemo(() =>
    props.windowId && props.session.windows.some((window) => window.id === props.windowId) ? props.windowId : ''
  );
  const visible = createMemo(() => props.visible);
  const [control, setControl] = createSignal(false);
  const [status, setStatus] = createSignal('Connecting…');
  const [retry, setRetry] = createSignal(0);
  const [clipboardOpen, setClipboardOpen] = createSignal(false);
  const [clipboardText, setClipboardText] = createSignal('');
  const [clipboardStatus, setClipboardStatus] = createSignal('');
  const [connected, setConnected] = createSignal(false);
  const [gaveUp, setGaveUp] = createSignal(false);
  const [stopping, setStopping] = createSignal(false);
  const [stopFailed, setStopFailed] = createSignal(false);
  async function stopAgent() {
    setStopping(true);
    setStopFailed(false);
    try {
      await props.onStopAgent();
    } catch {
      setStopFailed(true);
    } finally {
      setStopping(false);
    }
  }
  const [fullscreen, setFullscreen] = createSignal(false);
  const onFullscreenChange = () => setFullscreen(document.fullscreenElement === container);
  document.addEventListener('fullscreenchange', onFullscreenChange);
  onCleanup(() => document.removeEventListener('fullscreenchange', onFullscreenChange));
  function tryAgain() {
    failures = 0;
    setGaveUp(false);
    setRetry((value) => value + 1);
  }
  function toggleFullscreen() {
    if (fullscreen()) void document.exitFullscreen().catch(() => {});
    else void container?.requestFullscreen().catch(() => {});
  }
  let pasteTarget: HTMLTextAreaElement | undefined;
  let pasteWithShift = false;
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  let clipboardRead: AbortController | undefined;
  onCleanup(() => {
    clearTimeout(copyTimer);
    clipboardRead?.abort();
  });
  let screen: HTMLDivElement | undefined;
  let container: HTMLDivElement | undefined;
  let client: RFB | undefined;
  let failures = 0;
  const sessionId = createMemo(() => props.session.id);
  createEffect(
    on(
      () => props.environmentId,
      () => {
        setClipboardText('');
        setClipboardStatus('');
        setClipboardOpen(false);
        clearTimeout(copyTimer);
        clipboardRead?.abort();
      }
    )
  );
  function sendCombo(keysym: number, code: string, modifiers: { control: boolean; shift: boolean; alt: boolean }) {
    if (!client) return;
    // The remote desktop is Linux, including when the viewer is on macOS.
    client.sendKey(0xffeb, 'MetaLeft', false);
    client.sendKey(0xffec, 'MetaRight', false);
    if (modifiers.control) client.sendKey(0xffe3, 'ControlLeft', true);
    if (modifiers.alt) client.sendKey(0xffe9, 'AltLeft', true);
    if (modifiers.shift) client.sendKey(0xffe1, 'ShiftLeft', true);
    client.sendKey(keysym, code);
    if (modifiers.shift) client.sendKey(0xffe1, 'ShiftLeft', false);
    if (modifiers.alt) client.sendKey(0xffe9, 'AltLeft', false);
    if (modifiers.control) client.sendKey(0xffe3, 'ControlLeft', false);
  }
  function shortcut(key: string, shift = false) {
    if (!client || !connected()) return;
    client.viewOnly = false;
    setControl(true);
    sendCombo(key.charCodeAt(0), `Key${key.toUpperCase()}`, { control: true, shift, alt: false });
    if (key === 'c' || key === 'x') {
      const activeClient = client;
      clearTimeout(copyTimer);
      // Read after the remote app handles Copy/Cut, even when the selected
      // text is unchanged and the user has since changed the host clipboard.
      copyTimer = setTimeout(() => void copyRemoteClipboard(activeClient), 150);
    }
  }
  async function copyRemoteClipboard(activeClient: RFB) {
    clipboardRead?.abort();
    const request = new AbortController();
    clipboardRead = request;
    try {
      const response = await fetch(`${desktopBase(props.environmentId)}/clipboard`, { signal: request.signal });
      if (!response.ok) throw new Error('Clipboard unavailable');
      const { text } = (await response.json()) as { text: string };
      if (
        request.signal.aborted ||
        client !== activeClient ||
        !props.visible ||
        !screen?.contains(document.activeElement)
      )
        return;
      setClipboardText(text);
      try {
        await navigator.clipboard.writeText(text);
        setClipboardStatus('Copied to your clipboard');
      } catch {
        setClipboardOpen(true);
        setClipboardStatus('Browser blocked clipboard access. Choose Copy to computer.');
      }
    } catch {
      if (!request.signal.aborted) setClipboardStatus("Could not read the screen's clipboard. Try copying again.");
    } finally {
      if (clipboardRead === request) clipboardRead = undefined;
    }
  }
  async function pasteText(text: string, shift = false) {
    const activeClient = client;
    if (!activeClient || !connected()) return;
    clipboardRead?.abort();
    clearTimeout(copyTimer);
    try {
      const response = await fetch(`${desktopBase(props.environmentId)}/clipboard`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (response.status === 413) {
        activeClient.focus();
        setClipboardOpen(true);
        setClipboardStatus('Clipboard text must be smaller than 1 MiB.');
        return;
      }
      if (!response.ok) throw new Error('Clipboard transfer failed');
      if (client !== activeClient || !props.visible) return;
      setClipboardText(text);
      shortcut('v', shift);
      activeClient.focus();
      setClipboardStatus('Pasted into the screen');
    } catch {
      activeClient.focus();
      setClipboardOpen(true);
      setClipboardStatus('Could not send clipboard text. Reconnect or try again.');
    }
  }

  function receivePaste(event: ClipboardEvent) {
    if (!event.clipboardData || !connected()) return;
    event.preventDefault();
    event.stopPropagation();
    void pasteText(event.clipboardData.getData('text/plain'), pasteWithShift);
    pasteWithShift = false;
    if (pasteTarget) pasteTarget.value = '';
  }
  async function copyToComputer() {
    try {
      const response = await fetch(`${desktopBase(props.environmentId)}/clipboard`);
      if (response.ok) setClipboardText(((await response.json()) as { text: string }).text);
    } catch {
      // The text already in the box is still offered.
    }
    try {
      await navigator.clipboard.writeText(clipboardText());
      setClipboardStatus('Copied to your clipboard');
    } catch {
      setClipboardStatus('Select the text below and copy it with your keyboard.');
      setClipboardOpen(true);
    }
  }
  async function pasteFromComputer() {
    const activeClient = client;
    try {
      const text = await navigator.clipboard.readText();
      if (client === activeClient && props.visible) await pasteText(text);
    } catch {
      setClipboardOpen(true);
      setClipboardStatus('Paste into the text box, then choose Paste into screen.');
    }
  }
  createEffect(() => {
    const interactive = control();
    if (client) client.viewOnly = !interactive;
  });

  createEffect(on(selectedWindow, () => setControl(false), { defer: true }));

  createEffect(() => {
    const shown = visible();
    const environmentId = props.environmentId;
    const id = sessionId();
    const windowId = selectedWindow();
    retry();
    if (!shown) {
      failures = 0;
      setGaveUp(false);
      setConnected(false);
      setControl(false);
      return;
    }
    let disposed = false;
    let connection: RFB | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    const reconnect = () => {
      if (disposed || reconnectTimer) return;
      setControl(false);
      setConnected(false);
      if (failures >= MAX_RECONNECTS) {
        setGaveUp(true);
        return;
      }
      setStatus('Reconnecting…');
      const delay = Math.min(5000, 500 * 2 ** Math.min(failures++, 4));
      reconnectTimer = setTimeout(() => setRetry((value) => value + 1), delay);
    };
    const interact = () => {
      if (!connection || disposed) return;
      // Capture phase: enable input before noVNC receives this very click.
      connection.viewOnly = false;
      setControl(true);
    };
    // Window capture runs before the chat's shortcut listener on the document.
    const handledKeyUps = new Set<string>();
    const inDesktop = (event: Event) => event.target instanceof Node && !!screen?.contains(event.target);
    const keydown = (event: KeyboardEvent) => {
      if (!connected() || !inDesktop(event)) return;
      if (event.key === 'Meta') {
        event.stopPropagation();
        return;
      }
      if (!(event.ctrlKey || event.metaKey || event.altKey) || MODIFIER_KEYS.has(event.key) || typesACharacter(event)) {
        handledKeyUps.delete(event.code);
        return;
      }
      event.stopPropagation();
      handledKeyUps.add(event.code);
      const key = letterOf(event);
      if ((event.ctrlKey || event.metaKey) && !event.altKey && key === 'v') {
        // Let the browser's native paste event provide text, avoiding a
        // clipboard-read permission prompt on every keyboard paste.
        pasteWithShift = event.shiftKey;
        pasteTarget?.focus({ preventScroll: true });
        return;
      }
      event.preventDefault();
      if (event.repeat && ['c', 'x', 'a'].includes(key)) return;
      if ((event.ctrlKey || event.metaKey) && !event.altKey && ['c', 'x', 'a'].includes(key)) {
        shortcut(key, event.shiftKey);
        return;
      }
      const keysym = keysymOf(event);
      if (keysym === undefined || !client) return;
      client.viewOnly = false;
      setControl(true);
      sendCombo(keysym, event.code, {
        control: event.ctrlKey || event.metaKey,
        shift: event.shiftKey,
        alt: event.altKey,
      });
    };
    const keyup = (event: KeyboardEvent) => {
      if (handledKeyUps.delete(event.code) || (event.key === 'Meta' && inDesktop(event))) event.stopPropagation();
    };
    window.addEventListener('keydown', keydown, true);
    window.addEventListener('keyup', keyup, true);
    const copy = (event: ClipboardEvent) => {
      if (!connected()) return;
      event.preventDefault();
      event.stopPropagation();
      shortcut(event.type === 'cut' ? 'x' : 'c');
    };
    screen?.addEventListener('copy', copy);
    screen?.addEventListener('cut', copy);
    screen?.addEventListener('paste', receivePaste);
    screen?.addEventListener('pointerdown', interact, true);
    screen?.addEventListener('mousedown', interact, true);
    screen?.addEventListener('touchstart', interact, true);
    setConnected(false);
    setStatus('Connecting…');
    void import('@novnc/novnc')
      .then(({ default: Client }) => {
        if (disposed || !screen) return;
        const url = new URL(`${desktopBase(environmentId)}/sessions/${id}/connect`, location.href);
        url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        if (windowId) url.searchParams.set('window', windowId);
        url.searchParams.set('control', '1');
        connection = new Client(screen, url.href);
        connection.scaleViewport = true;
        client = connection;
        connection.viewOnly = !control();
        connection.background = getComputedStyle(screen).backgroundColor;
        const canvas = screen.querySelector('canvas');
        if (canvas) canvas.style.margin = '0 auto';
        connection.addEventListener('connect', () => {
          if (!disposed) {
            failures = 0;
            setGaveUp(false);
            setConnected(true);
            setStatus('Connected');
          }
        });
        connection.addEventListener('disconnect', () => {
          reconnect();
        });
        connection.addEventListener('securityfailure', () => {
          reconnect();
        });
      })
      .catch(() => {
        reconnect();
      });
    onCleanup(() => {
      disposed = true;
      clipboardRead?.abort();
      clearTimeout(reconnectTimer);
      window.removeEventListener('keydown', keydown, true);
      window.removeEventListener('keyup', keyup, true);
      screen?.removeEventListener('copy', copy);
      screen?.removeEventListener('cut', copy);
      screen?.removeEventListener('paste', receivePaste);
      screen?.removeEventListener('pointerdown', interact, true);
      screen?.removeEventListener('mousedown', interact, true);
      screen?.removeEventListener('touchstart', interact, true);
      if (client === connection) client = undefined;
      connection?.disconnect();
    });
  });

  return (
    <div ref={container} data-remote-desktop class="flex min-h-0 flex-1 flex-col bg-background">
      <div class="h-8 flex items-center gap-2 px-1.5 bg-sidebar border-b border-border shrink-0">
        <div class="flex flex-1 min-w-0 items-center gap-1">
          <Show when={props.onCollapse}>
            {(collapse) => (
              <ToolbarButton onClick={collapse()} tooltip="Close panel">
                <PanelRightClose class="w-3.5 h-3.5" />
              </ToolbarButton>
            )}
          </Show>
          <Show when={props.session.windows.length > 1}>
            <select
              aria-label="Show all windows or one"
              class="h-6 min-w-0 max-w-full truncate rounded border border-border bg-background px-1.5 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              value={selectedWindow()}
              onChange={(event) => props.onSelectWindow(event.currentTarget.value)}
            >
              <option value="">All windows</option>
              <For each={props.session.windows}>
                {(window) => (
                  <option value={window.id} selected={window.id === selectedWindow()}>
                    {window.title || 'Untitled window'}
                  </option>
                )}
              </For>
            </select>
          </Show>
        </div>
        {props.switcher}
        <div class="flex flex-1 items-center justify-end gap-0.5" classList={{ hidden: props.mobile }}>
          <ToolbarButton
            aria-expanded={clipboardOpen()}
            onClick={() => setClipboardOpen(!clipboardOpen())}
            tooltip="Clipboard"
          >
            <ClipboardPaste class="w-3.5 h-3.5" />
          </ToolbarButton>
          <ToolbarButton onClick={toggleFullscreen} tooltip={fullscreen() ? 'Exit full screen' : 'Full screen'}>
            <Show when={fullscreen()} fallback={<Maximize2 class="w-3.5 h-3.5" />}>
              <Minimize2 class="w-3.5 h-3.5" />
            </Show>
          </ToolbarButton>
        </div>
      </div>
      <Show when={control() && props.agentWorking}>
        <div role="status" class="of-banner of-tone-needs-you flex shrink-0 flex-wrap items-center gap-2 px-3 py-2">
          <p class="min-w-0 flex-1 text-sm">
            {stopFailed()
              ? "Couldn't stop the agent. Use Stop in the chat."
              : 'The agent is still working and may use this screen at the same time.'}
          </p>
          <Button
            size="sm"
            variant="outline"
            class="h-7 text-xs"
            disabled={stopping()}
            onClick={() => void stopAgent()}
          >
            {stopping() ? 'Stopping…' : 'Stop the agent'}
          </Button>
        </div>
      </Show>
      <Show when={props.mobile}>
        <p class="px-3 py-4 text-sm text-muted-foreground">
          The screen is too small to use on a phone. Open this project on a computer to use it.
        </p>
      </Show>
      <p
        class="flex shrink-0 items-center gap-2 px-2 py-1 text-xs text-muted-foreground"
        classList={{ hidden: props.mobile }}
        aria-live="polite"
      >
        <Show
          when={!gaveUp()}
          fallback={
            <>
              <span>Can't reach the screen. The project may be restarting.</span>
              <Button size="sm" variant="outline" class="h-6 px-2 text-xs" onClick={tryAgain}>
                Try again
              </Button>
            </>
          }
        >
          <span>
            {connected() ? (control() ? 'You are using the screen' : 'Click the screen to use it') : status()}
            <Show when={selectedWindow()}> · Dialogs open as separate windows; pick All windows to see them</Show>
          </span>
        </Show>
      </p>
      <Show when={clipboardOpen()}>
        <div class="space-y-2 border-b border-border p-2">
          <p class="text-xs text-muted-foreground">
            Copy and paste text with Ctrl/Cmd+C and Ctrl/Cmd+V, or use these controls.
          </p>
          <textarea
            aria-label="Screen clipboard text"
            name="desktop-clipboard"
            autocomplete="off"
            spellcheck={false}
            class="h-20 w-full resize-y rounded border border-input bg-background p-2 text-sm"
            value={clipboardText()}
            onInput={(event) => setClipboardText(event.currentTarget.value)}
          />
          <div class="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={!connected()} onClick={() => void pasteFromComputer()}>
              Paste from computer
            </Button>
            <Button size="sm" variant="outline" disabled={!connected()} onClick={() => void pasteText(clipboardText())}>
              Paste into screen
            </Button>
            <Button size="sm" variant="outline" onClick={() => void copyToComputer()}>
              Copy to computer
            </Button>
          </div>
          <p class="text-xs text-muted-foreground" role="status">
            {clipboardStatus()}
          </p>
        </div>
      </Show>
      <textarea
        ref={pasteTarget}
        class="sr-only"
        tabIndex={-1}
        aria-label="Paste into the screen"
        onPaste={receivePaste}
        onBlur={() => {
          if (pasteTarget) pasteTarget.value = '';
        }}
      />
      <div
        ref={screen}
        role="application"
        aria-label="Remote screen"
        class="min-h-0 flex-1 overflow-hidden bg-background focus-within:ring-1 focus-within:ring-inset focus-within:ring-ring"
      />
    </div>
  );
}
