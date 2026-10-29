import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from 'solid-js';
import type RFB from '@novnc/novnc';
import { desktopBase, type DesktopSession } from '~/api/desktops';
import { Button } from '~/components/ui/button';

export function DesktopPreviewPane(props: {
  environmentId: string;
  session: DesktopSession;
  visible: boolean;
  windowId: string;
  onOpenWindow: (window: string) => void;
}) {
  const [selectedWindow, setSelectedWindow] = createSignal('');
  const [control, setControl] = createSignal(false);
  const [status, setStatus] = createSignal('Connecting…');
  const [retry, setRetry] = createSignal(0);
  const [clipboardOpen, setClipboardOpen] = createSignal(false);
  const [clipboardText, setClipboardText] = createSignal('');
  const [clipboardStatus, setClipboardStatus] = createSignal('');
  const [connected, setConnected] = createSignal(false);
  let pasteTarget: HTMLTextAreaElement | undefined;
  let pasteWithShift = false;
  let lastClipboardText: string | undefined;
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
        lastClipboardText = undefined;
        setClipboardText('');
        setClipboardStatus('');
        setClipboardOpen(false);
        clearTimeout(copyTimer);
        clipboardRead?.abort();
      }
    )
  );
  function shortcut(key: string, shift = false) {
    if (!client || !connected()) return;
    client.viewOnly = false;
    setControl(true);
    // The remote desktop is Linux, including when the viewer is on macOS.
    client.sendKey(0xffeb, 'MetaLeft', false);
    client.sendKey(0xffec, 'MetaRight', false);
    client.sendKey(0xffe3, 'ControlLeft', true);
    if (shift) client.sendKey(0xffe1, 'ShiftLeft', true);
    client.sendKey(key.charCodeAt(0), `Key${key.toUpperCase()}`);
    if (shift) client.sendKey(0xffe1, 'ShiftLeft', false);
    client.sendKey(0xffe3, 'ControlLeft', false);
    if (key === 'c' || key === 'x') {
      const activeClient = client;
      clearTimeout(copyTimer);
      // Read after the remote app handles Copy/Cut, even when the selected
      // text is unchanged and the user has since changed the host clipboard.
      copyTimer = setTimeout(() => void copyRemoteClipboard(activeClient), 150);
    }
  }
  async function copyRemoteClipboard(activeClient: RFB, force = true) {
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
        (!force && !document.hasFocus()) ||
        !screen?.contains(document.activeElement)
      )
        return;
      if (!force && lastClipboardText === undefined) {
        // Establish a baseline without overwriting something just copied on
        // the host when the user first clicks into the desktop.
        lastClipboardText = text;
        setClipboardText(text);
        return;
      }
      if (!force && text === lastClipboardText) return;
      lastClipboardText = text;
      setClipboardText(text);
      try {
        await navigator.clipboard.writeText(text);
        setClipboardStatus('Copied to your clipboard');
      } catch {
        setClipboardOpen(true);
        setClipboardStatus('Browser blocked clipboard access. Choose Copy to computer.');
      }
    } catch {
      if (force && !request.signal.aborted)
        setClipboardStatus('Could not read the desktop clipboard. Try copying again.');
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
        setClipboardOpen(true);
        setClipboardStatus('Clipboard text must be smaller than 1 MiB.');
        return;
      }
      if (!response.ok) throw new Error('Clipboard transfer failed');
      if (client !== activeClient || !props.visible) return;
      lastClipboardText = text;
      setClipboardText(text);
      shortcut('v', shift);
      activeClient.focus();
      setClipboardStatus('Pasted into desktop');
    } catch {
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
      setClipboardStatus('Paste into the text box, then choose Paste into desktop.');
    }
  }
  createEffect(() => {
    const interactive = control();
    if (client) client.viewOnly = !interactive;
  });

  createEffect(
    on(
      () => props.windowId,
      (window) => {
        setSelectedWindow(window);
        setControl(false);
      }
    )
  );
  createEffect(() => {
    if (selectedWindow() && !props.session.windows.some((window) => window.id === selectedWindow())) {
      setSelectedWindow('');
    }
  });

  createEffect(() => {
    const visible = props.visible;
    const environmentId = props.environmentId;
    const id = sessionId();
    const window = selectedWindow();
    retry();
    if (!visible) {
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
    const keydown = (event: KeyboardEvent) => {
      if (!connected() || event.altKey) return;
      const key = event.key.toLowerCase();
      if (event.key === 'Meta') {
        event.stopImmediatePropagation();
        return;
      }
      if (!(event.ctrlKey || event.metaKey) || !['v', 'c', 'x', 'a'].includes(key)) return;
      event.stopImmediatePropagation();
      if (event.repeat) {
        event.preventDefault();
        return;
      }
      if (key === 'v') {
        // Let the browser's native paste event provide text, avoiding a
        // clipboard-read permission prompt on every keyboard paste.
        pasteWithShift = event.shiftKey;
        pasteTarget?.focus({ preventScroll: true });
      } else {
        event.preventDefault();
        shortcut(key, event.shiftKey);
      }
    };
    const keyup = (event: KeyboardEvent) => {
      if (event.key === 'Meta') event.stopImmediatePropagation();
    };
    screen?.addEventListener('keydown', keydown, true);
    screen?.addEventListener('keyup', keyup, true);
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
        if (window) url.searchParams.set('window', window);
        url.searchParams.set('control', '1');
        connection = new Client(screen, url.href);
        connection.scaleViewport = true;
        client = connection;
        connection.viewOnly = !control();
        connection.background = '#18181b';
        connection.addEventListener('connect', () => {
          if (!disposed) {
            failures = 0;
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
      screen?.removeEventListener('keydown', keydown, true);
      screen?.removeEventListener('keyup', keyup, true);
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

  createEffect(() => {
    if (!props.visible) return;
    // Only one focused desktop view polls. This also covers Copy from native
    // app menus, which may not produce a reliable legacy RFB clipboard event.
    const timer = setInterval(() => {
      if (
        client &&
        connected() &&
        control() &&
        !clipboardRead &&
        document.hasFocus() &&
        screen?.contains(document.activeElement)
      ) {
        void copyRemoteClipboard(client, false);
      }
    }, 1000);
    onCleanup(() => clearInterval(timer));
  });

  return (
    <div ref={container} data-remote-desktop class="flex min-h-0 flex-1 flex-col bg-background">
      <div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-sidebar p-2">
        <Show
          when={!props.windowId}
          fallback={<span class="min-w-0 flex-1 text-xs text-muted-foreground">Window view</span>}
        >
          <select
            aria-label="Desktop or window"
            class="min-w-0 flex-1 rounded border border-input bg-background px-2 py-1 text-xs"
            value={selectedWindow()}
            onChange={(event) => {
              setControl(false);
              const window = event.currentTarget.value;
              if (window) props.onOpenWindow(window);
              event.currentTarget.value = selectedWindow();
            }}
          >
            <option value="">Whole desktop · open a window separately…</option>
            <For each={props.session.windows}>
              {(window) => <option value={window.id}>{window.title || window.id}</option>}
            </For>
          </select>
        </Show>
        <Button
          size="sm"
          variant="ghost"
          class="h-7 text-xs"
          aria-expanded={clipboardOpen()}
          onClick={() => setClipboardOpen(!clipboardOpen())}
        >
          Clipboard
        </Button>
        <Button size="sm" variant="ghost" class="h-7 text-xs" onClick={() => void container?.requestFullscreen()}>
          Full screen
        </Button>
      </div>
      <div class="flex items-center justify-between gap-2 px-2 py-1 text-xs text-muted-foreground" aria-live="polite">
        <span>
          {status()} · {control() ? 'You can interact' : 'Click desktop to interact'}
        </span>
      </div>
      <Show when={clipboardOpen()}>
        <div class="space-y-2 border-b border-border p-2">
          <p class="text-xs text-muted-foreground">
            Copy and paste text with Ctrl/Cmd+C and Ctrl/Cmd+V, or use these controls.
          </p>
          <textarea
            aria-label="Desktop clipboard text"
            class="h-20 w-full resize-y rounded border border-input bg-background p-2 text-sm"
            value={clipboardText()}
            onInput={(event) => setClipboardText(event.currentTarget.value)}
          />
          <div class="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={!connected()} onClick={() => void pasteFromComputer()}>
              Paste from computer
            </Button>
            <Button size="sm" variant="outline" disabled={!connected()} onClick={() => void pasteText(clipboardText())}>
              Paste into desktop
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
        aria-label="Paste into remote desktop"
        onPaste={receivePaste}
        onBlur={() => {
          if (pasteTarget) pasteTarget.value = '';
        }}
      />
      <Show when={selectedWindow()}>
        <p class="px-2 pb-1 text-xs text-muted-foreground">For dialogs or other windows, use the Desktop panel.</p>
      </Show>
      <div ref={screen} class="min-h-0 flex-1 overflow-hidden bg-zinc-900" aria-label="Remote desktop" />
    </div>
  );
}
