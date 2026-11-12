import { createEffect, createSignal, onCleanup, type Accessor, type Component } from 'solid-js';
import type { BaseRouterProps } from '@solidjs/router';
import { api, apiRelative, ApiError, type ProjectStatus } from '~/api/client';
import { useConnectEnvironment, type ProjectEnvironmentStatus } from '~/api/environments';
import { createPersistedSignal } from '~/lib/persisted-signal';
import { createSessionRouter } from './platform';

type ConnectionStatus = ProjectStatus | ProjectEnvironmentStatus;

export type ConnectionProblem = 'unreachable' | 'unconfirmed-prompt';

const STARTING_RETRY_MS = 2_000;

const OPEN_CHATS_KEY = 'opsiforce:project-chat:open-session';

interface RuntimeSession {
  data: { id: string; time: { archived?: number } };
}

export interface InitialPrompt {
  id: string;
  text: string;
}

export interface OpenCodeConnectionOptions {
  projectId: string;
  environmentId: Accessor<string>;
  status: Accessor<ConnectionStatus | undefined>;
  initialPrompt: Accessor<InitialPrompt | undefined>;
  onInitialPromptAdmitted: () => void;
}

export function useOpenCodeConnection(options: OpenCodeConnectionOptions) {
  const [router, setRouter] = createSignal<Component<BaseRouterProps> | null>(null);
  const connectEnvironment = useConnectEnvironment();

  const [problem, setProblem] = createSignal<ConnectionProblem | null>(null);
  const [openChats, setOpenChats] = createPersistedSignal<Record<string, string>>(OPEN_CHATS_KEY, {});
  let controller = new AbortController();
  let disposed = false;
  let connecting = false;
  let attempts = 0;
  let prevStatus: ConnectionStatus | undefined;
  let prevEnvId: string | undefined;

  async function admitInitialPrompt(
    environmentId: string,
    runtimePath: string,
    sessionId: string,
    isCurrent: () => boolean,
    signal: AbortSignal
  ): Promise<boolean> {
    const intent = options.initialPrompt();
    if (!intent || environmentId !== options.projectId) return false;

    await api.post(
      `${runtimePath}/api/session/${sessionId}/prompt`,
      {
        id: intent.id,
        text: intent.text,
      },
      { signal }
    );
    if (isCurrent()) options.onInitialPromptAdmitted();
    return true;
  }

  async function chatToReopen(environmentId: string, runtimePath: string, primarySessionId: string): Promise<string> {
    const remembered = openChats()[environmentId];
    if (!remembered || remembered === primarySessionId) return primarySessionId;
    try {
      const { data } = await api.get<RuntimeSession>(`${runtimePath}/api/session/${remembered}`);
      return data.time.archived ? primarySessionId : data.id;
    } catch {
      return primarySessionId;
    }
  }

  function rememberOpenChat(environmentId: string, sessionId: string) {
    setOpenChats((chats) => (chats[environmentId] === sessionId ? chats : { ...chats, [environmentId]: sessionId }));
  }

  async function connect(environmentId: string) {
    const attempt = ++attempts;
    const isCurrent = () =>
      !disposed && !controller.signal.aborted && attempt === attempts && environmentId === options.environmentId();

    let connection;
    try {
      connection = await connectEnvironment(options.projectId, environmentId, controller.signal);
    } catch (error) {
      if (!isCurrent()) return;
      if (error instanceof ApiError && error.code === 'environment_starting') {
        window.setTimeout(() => {
          if (isCurrent()) void connect(environmentId);
        }, STARTING_RETRY_MS);
        return;
      }
      connecting = false;
      setProblem('unreachable');
      return;
    }
    if (!isCurrent()) return;

    const serverUrl = new URL(connection.baseUrl, window.location.origin).href;
    const runtimePath = apiRelative(connection.baseUrl);

    let admitted: boolean;
    try {
      admitted = await admitInitialPrompt(
        environmentId,
        runtimePath,
        connection.sessionId,
        isCurrent,
        controller.signal
      );
    } catch {
      if (isCurrent()) {
        connecting = false;
        setProblem('unconfirmed-prompt');
      }
      return;
    }
    if (!isCurrent()) return;

    const sessionId = admitted
      ? connection.sessionId
      : await chatToReopen(environmentId, runtimePath, connection.sessionId);
    if (!isCurrent()) return;

    rememberOpenChat(environmentId, sessionId);
    setRouter(() => createSessionRouter(serverUrl, sessionId, (shown) => rememberOpenChat(environmentId, shown)));
  }

  function reset() {
    controller.abort();
    controller = new AbortController();
    setProblem(null);
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
    setProblem(null);
    connecting = true;
    void connect(options.environmentId());
  }

  const openChat = (environmentId: string): string | undefined => openChats()[environmentId];

  return { router, reset, problem, retry, openChat };
}
