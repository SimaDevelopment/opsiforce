export interface AgentStatusEvent {
  projectId: string;
  agentStatus: string;
  waitingForInput?: boolean;
}

export interface EnvironmentStatusEvent extends AgentStatusEvent {
  environmentId: string;
}

export interface AppStateEvent {
  projectId: string;
  environmentId: string;
  serving: boolean;
}

export interface AgentStatusStream {
  events: AgentStatusEvent[];
  environmentEvents: EnvironmentStatusEvent[];
  appEvents: AppStateEvent[];
  statusesOf: (projectId: string) => string[];
  waitingOf: (projectId: string) => boolean[];
  environmentStatusesOf: (environmentId: string) => string[];
  servingOf: (environmentId: string) => boolean[];
  close: () => void;
}

export async function openAgentStatusStream(
  baseUrl: string,
  headers: Record<string, string>
): Promise<AgentStatusStream> {
  const aborter = new AbortController();
  const res = await fetch(`${baseUrl}/api/agent-status/events`, { headers, signal: aborter.signal });
  if (!res.ok || !res.body) throw new Error(`agent-status stream answered ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events: AgentStatusEvent[] = [];
  const environmentEvents: EnvironmentStatusEvent[] = [];
  const appEvents: AppStateEvent[] = [];
  let buffered = '';

  void (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffered += decoder.decode(value, { stream: true });
      let boundary = buffered.indexOf('\n\n');
      while (boundary >= 0) {
        const frame = buffered.slice(0, boundary);
        buffered = buffered.slice(boundary + 2);
        const lines = frame.split('\n');
        const name = lines.find((line) => line.startsWith('event: '))?.slice('event: '.length);
        const data = lines
          .filter((line) => line.startsWith('data: '))
          .map((line) => line.slice('data: '.length))
          .join('\n');
        if (data && name === 'environment') environmentEvents.push(JSON.parse(data) as EnvironmentStatusEvent);
        else if (data && name === 'app') appEvents.push(JSON.parse(data) as AppStateEvent);
        else if (data) events.push(JSON.parse(data) as AgentStatusEvent);
        boundary = buffered.indexOf('\n\n');
      }
    }
  })().catch(() => undefined);

  return {
    events,
    environmentEvents,
    appEvents,
    statusesOf: (projectId) => events.filter((event) => event.projectId === projectId).map((e) => e.agentStatus),
    waitingOf: (projectId) =>
      events.filter((event) => event.projectId === projectId).map((e) => e.waitingForInput === true),
    environmentStatusesOf: (environmentId) =>
      environmentEvents.filter((event) => event.environmentId === environmentId).map((e) => e.agentStatus),
    servingOf: (environmentId) =>
      appEvents.filter((event) => event.environmentId === environmentId).map((e) => e.serving),
    close: () => aborter.abort(),
  };
}
