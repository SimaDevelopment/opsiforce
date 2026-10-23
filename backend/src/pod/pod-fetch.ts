import { Agent, buildConnector, fetch } from 'undici';

export interface PodRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  redirect?: 'follow' | 'manual';
}

const connect = buildConnector({});
const podAgents = new Map<string, Agent>();

export function fetchAsLocalhost(url: URL, init: PodRequestInit = {}): Promise<Response> {
  const presented = new URL(`${url.pathname}${url.search}`, `http://localhost:${url.port}`);
  return fetch(presented, { ...init, dispatcher: agentFor(url) }) as unknown as Promise<Response>;
}

function agentFor(pod: URL): Agent {
  let agent = podAgents.get(pod.host);
  if (!agent) {
    agent = new Agent({
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
    podAgents.set(pod.host, agent);
  }
  return agent;
}
