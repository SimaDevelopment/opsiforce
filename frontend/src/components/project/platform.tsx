import type { Component } from 'solid-js';
import { MemoryRouter, createMemoryHistory, type BaseRouterProps } from '@solidjs/router';
import { type Platform, ServerConnection } from '@opencode/app';
import { base64Encode } from '@opencode/util/encode';

const reloadOnExpiredSession: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  if (response.status !== 401) return response;
  window.location.reload();
  return new Promise<Response>(() => {});
};

export function createProxyPlatform(): Platform {
  return {
    platform: 'web',
    openExternal: (url: string) => window.open(url, '_blank'),
    restart: async () => window.location.reload(),
    notify: async () => {},
    fetch: reloadOnExpiredSession,
  };
}

export function createSessionRouter(serverUrl: string, sessionId: string): Component<BaseRouterProps> {
  const serverKey = ServerConnection.Key.make(serverUrl);
  const initialPath = `/server/${base64Encode(serverKey)}/session/${sessionId}`;

  return (props) => {
    const history = createMemoryHistory();
    history.set({ value: initialPath });

    return (
      <MemoryRouter root={props.root} history={history}>
        {props.children}
      </MemoryRouter>
    );
  };
}
