import type { JsonValue } from '../common/json';

export interface PodEnvironmentRef {
  id: string;
  podIp: string | null;
}

export interface SessionInfo {
  id: string;
  parentID?: string | null;
  title?: string;
  time: { created: number; updated: number; idle?: number };
  [key: string]: JsonValue | undefined;
}

export interface RuntimeHealth {
  healthy?: boolean;
  version?: string;
  pid?: number;
}

export interface ActiveSessionSnapshot {
  sessionIds: string[];
  busy: boolean;
}

export interface AgentConnection {
  environmentId: string;
  baseUrl: string;
  openapiUrl: string;
  sessionId: string;
  build: string | null;
}
