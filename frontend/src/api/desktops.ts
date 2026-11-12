import { createEffect, createSignal, onCleanup, type Accessor } from 'solid-js';

export interface DesktopWindow {
  id: string;
  title: string;
  pid: number;
  /** The window's application class, e.g. `Chromium`. */
  app: string;
}

export interface DesktopSession {
  id: string;
  title: string;
  display: string;
  windows: DesktopWindow[];
  visible: boolean;
  preferredWindow: string;
  presentation: number;
}

export function desktopBase(environmentId: string) {
  return `/api/proxy/${encodeURIComponent(environmentId)}/_desktop`;
}

const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 15_000];
export function createDesktopSessions(
  environmentId: Accessor<string>,
  enabled: Accessor<boolean>
): Accessor<DesktopSession | undefined> {
  const [session, setSession] = createSignal<DesktopSession | undefined>();

  createEffect(() => {
    const id = environmentId();
    setSession(undefined);
    if (!enabled()) return;

    let source: EventSource | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const connect = () => {
      clearTimeout(retryTimer);
      source?.close();
      source = new EventSource(`${desktopBase(id)}/sessions/events`);
      source.addEventListener('message', (event) => {
        failures = 0;
        try {
          setSession((JSON.parse(event.data) as DesktopSession[])[0]);
        } catch {
          setSession(undefined);
        }
      });
      source.addEventListener('error', () => {
        source?.close();
        const delay = RETRY_DELAYS_MS[failures++];
        if (delay !== undefined) retryTimer = setTimeout(connect, delay);
      });
    };
    const retryWhenShown = () => {
      if (document.visibilityState !== 'visible' || source?.readyState !== EventSource.CLOSED) return;
      if (failures < RETRY_DELAYS_MS.length) return;
      failures = 0;
      connect();
    };
    document.addEventListener('visibilitychange', retryWhenShown);
    connect();
    onCleanup(() => {
      document.removeEventListener('visibilitychange', retryWhenShown);
      clearTimeout(retryTimer);
      source?.close();
    });
  });

  return session;
}

function opencodeBase(environmentId: string) {
  return `/api/proxy/${encodeURIComponent(environmentId)}`;
}

/** Interrupts the chat the person has open, or every running one when that is unknown. */
export async function stopAgent(environmentId: string, sessionId?: string): Promise<void> {
  if (sessionId) {
    const stopped = await fetch(
      `${opencodeBase(environmentId)}/api/session/${encodeURIComponent(sessionId)}/interrupt`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }
    );
    if (!stopped.ok) throw new Error('Could not stop the session');
    return;
  }
  const response = await fetch(`${opencodeBase(environmentId)}/api/session/active`);
  if (!response.ok) throw new Error('Could not read the running sessions');
  const { data } = (await response.json()) as { data?: Record<string, unknown> };
  await Promise.all(
    Object.keys(data ?? {}).map((sessionId) =>
      fetch(`${opencodeBase(environmentId)}/api/session/${encodeURIComponent(sessionId)}/interrupt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
    )
  );
}
