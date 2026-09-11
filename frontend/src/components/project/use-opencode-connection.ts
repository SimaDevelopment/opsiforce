import { createEffect, createSignal, onCleanup, type Accessor, type Component } from 'solid-js';
import type { BaseRouterProps } from '@solidjs/router';
import { api, apiRelative, type OpenCodeSession, type ProjectStatus } from '~/api/client';
import { useConnectEnvironment, type ProjectEnvironmentStatus } from '~/api/environments';
import { useSyncProjectTitle } from '~/api/projects';
import { createSessionRouter } from './platform';

type ConnectionStatus = ProjectStatus | ProjectEnvironmentStatus;

export interface InitialPrompt {
  id: string;
  text: string;
}

export interface OpenCodeConnectionOptions {
  projectId: string;
  environmentId: Accessor<string>;
  status: Accessor<ConnectionStatus | undefined>;
  currentTitle: Accessor<string | null | undefined>;
  initialPrompt: Accessor<InitialPrompt | undefined>;
  onInitialPromptAdmitted: () => void;
}

export function useOpenCodeConnection(options: OpenCodeConnectionOptions) {
  const [router, setRouter] = createSignal<Component<BaseRouterProps> | null>(null);
  const syncProjectTitle = useSyncProjectTitle();
  const connectEnvironment = useConnectEnvironment();

  const [error, setError] = createSignal<string | null>(null);
  let controller = new AbortController();
  let disposed = false;
  let connecting = false;
  let attempts = 0;
  let prevStatus: ConnectionStatus | undefined;
  let prevEnvId: string | undefined;

  async function syncTitle(runtimePath: string, sessionId: string): Promise<void> {
    try {
      const response = await api.get<{ data?: OpenCodeSession }>(`${runtimePath}/api/session/${sessionId}`);
      const title = response?.data?.title;
      if (title) syncProjectTitle(options.projectId, title, options.currentTitle());
    } catch {}
  }

  async function admitInitialPrompt(
    environmentId: string,
    runtimePath: string,
    sessionId: string,
    isCurrent: () => boolean,
    signal: AbortSignal
  ): Promise<void> {
    const intent = options.initialPrompt();
    if (!intent || environmentId !== options.projectId) return;

    await api.post(
      `${runtimePath}/api/session/${sessionId}/prompt`,
      {
        id: intent.id,
        text: intent.text,
      },
      { signal }
    );
    if (isCurrent()) options.onInitialPromptAdmitted();
  }

  async function connect(environmentId: string) {
    const attempt = ++attempts;
    const isCurrent = () =>
      !disposed && !controller.signal.aborted && attempt === attempts && environmentId === options.environmentId();

    let connection;
    try {
      connection = await connectEnvironment(options.projectId, environmentId, controller.signal);
    } catch {
      if (isCurrent()) {
        connecting = false;
        setError('Could not connect to this project. Try again.');
      }
      return;
    }
    if (!isCurrent()) return;

    const serverUrl = new URL(connection.baseUrl, window.location.origin).href;
    const runtimePath = apiRelative(connection.baseUrl);

    try {
      await admitInitialPrompt(environmentId, runtimePath, connection.sessionId, isCurrent, controller.signal);
    } catch {
      if (isCurrent()) {
        connecting = false;
        setError('Your message could not be confirmed. Retry to send the same message safely.');
      }
      return;
    }
    if (!isCurrent()) return;

    void syncTitle(runtimePath, connection.sessionId);
    setRouter(() => createSessionRouter(serverUrl, connection.sessionId));
  }

  function reset() {
    controller.abort();
    controller = new AbortController();
    setError(null);
    attempts += 1;
    setRouter(null);
    connecting = false;
  }

  createEffect(() => {
    const status = options.status();
    const envId = options.environmentId();
    if (!status) return;

    if (envId !== prevEnvId) {
      reset();
      prevEnvId = envId;
      prevStatus = undefined;
    }

    if (status === 'disabled') {
      reset();
      prevStatus = status;
      return;
    }

    if (status === 'starting' && prevStatus && prevStatus !== 'starting') {
      reset();
    }

    if (status === 'active' && !connecting) {
      connecting = true;
      connect(envId);
    }

    prevStatus = status;
  });

  onCleanup(() => {
    disposed = true;
    attempts += 1;
    controller.abort();
  });

  function retry() {
    if (disposed || connecting) return;
    setError(null);
    connecting = true;
    void connect(options.environmentId());
  }

  return { router, reset, error, retry };
}
