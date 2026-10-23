import { Agent, buildConnector, fetch } from 'undici';

export interface PodRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  redirect?: 'follow' | 'manual';
}

const connect = buildConnector({});

export async function fetchAsLocalhost(url: URL, init: PodRequestInit = {}): Promise<Response> {
  const presented = new URL(`${url.pathname}${url.search}`, `http://localhost:${url.port}`);
  const pod = podDispatcher(url);
  try {
    return (await fetch(presented, { ...init, dispatcher: pod })) as unknown as Response;
  } finally {
    void pod.close();
  }
}

function podDispatcher(pod: URL): Agent {
  return new Agent({
    connect: (options, callback) => {
      if (options.hostname !== 'localhost' || options.port !== pod.port) {
        callback(
          new Error(`The App is only reachable as localhost:${pod.port}, not ${options.host ?? options.hostname}`),
          null
        );
        return;
      }
      connect({ ...options, hostname: pod.hostname, host: pod.host }, callback);
    },
  });
}
