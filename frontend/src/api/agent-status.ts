import { createEffect, onCleanup } from 'solid-js';
import { createStore } from 'solid-js/store';
import { createTenantState } from '~/lib/tenant-state';
import type { AgentStatus, Project } from './client';

interface AgentStatusEvent {
  projectId: string;
  agentStatus: AgentStatus;
  waitingForInput?: boolean;
}

interface EnvironmentStatusEvent extends AgentStatusEvent {
  environmentId: string;
}

interface AppStateEvent {
  projectId: string;
  environmentId: string;
  serving: boolean;
}

type EnvironmentListener = (environmentId: string) => void;

const [agentStatuses, setAgentStatuses] = createStore<Record<string, AgentStatus>>({});
const [waitingForInput, setWaitingForInput] = createStore<Record<string, boolean>>({});
const environmentIdleListeners = new Set<EnvironmentListener>();
const appServingListeners = new Set<EnvironmentListener>();

export function isAgentWorking(projectId: string): boolean {
  return agentStatuses[projectId] === 'working';
}

/** A chat in this Project is waiting for an answer or a permission. */
export function isAgentWaiting(projectId: string): boolean {
  return waitingForInput[projectId] === true;
}

export function onEnvironmentIdle(environmentId: () => string, callback: () => void): void {
  listenForEnvironment(environmentIdleListeners, environmentId, callback);
}

export function onAppServing(environmentId: () => string, callback: () => void): void {
  listenForEnvironment(appServingListeners, environmentId, callback);
}

function listenForEnvironment(
  listeners: Set<EnvironmentListener>,
  environmentId: () => string,
  callback: () => void
): void {
  const listener: EnvironmentListener = (eventEnvironmentId) => {
    if (eventEnvironmentId === environmentId()) callback();
  };
  listeners.add(listener);
  onCleanup(() => listeners.delete(listener));
}

function applyEnvironmentStatus({ environmentId, agentStatus }: EnvironmentStatusEvent): void {
  if (agentStatus !== 'idle') return;
  for (const listener of environmentIdleListeners) listener(environmentId);
}

function applyAppState({ environmentId, serving }: AppStateEvent): void {
  if (!serving) return;
  for (const listener of appServingListeners) listener(environmentId);
}

export function useAgentStatusStream(projects: () => Project[] | undefined): void {
  const [tenant] = createTenantState();

  createEffect(() => {
    const tenantName = tenant();
    const currentProjects = projects() ?? [];
    setAgentStatuses({});
    for (const project of currentProjects) {
      setAgentStatuses(project.id, project.agentStatus ?? 'idle');
      setWaitingForInput(project.id, project.waitingForInput === true);
    }

    const events = new EventSource(agentStatusEventsUrl(tenantName));
    events.addEventListener('message', (event) => {
      try {
        const { projectId, agentStatus, waitingForInput: waiting } = JSON.parse(event.data) as AgentStatusEvent;
        setAgentStatuses(projectId, agentStatus);
        if (waiting !== undefined) setWaitingForInput(projectId, waiting);
      } catch {}
    });
    events.addEventListener('environment', (event) => {
      try {
        applyEnvironmentStatus(JSON.parse(event.data) as EnvironmentStatusEvent);
      } catch {}
    });
    events.addEventListener('app', (event) => {
      try {
        applyAppState(JSON.parse(event.data) as AppStateEvent);
      } catch {}
    });
    onCleanup(() => events.close());
  });
}

function agentStatusEventsUrl(tenant: string): string {
  const params = new URLSearchParams();
  if (tenant) params.set('tenant', tenant);
  const query = params.toString();
  return `/api/agent-status/events${query ? `?${query}` : ''}`;
}
