export interface AgentObservation {
  kind: string;
  sessionId: string;
  [field: string]: unknown;
}

export interface ObservedEnvironment {
  projectId: string;
  environmentId: string;
}

export function parseAgentObservation(body: unknown): AgentObservation | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const { kind, sessionId } = body as Record<string, unknown>;
  if (!isNonEmptyString(kind) || !isNonEmptyString(sessionId)) return null;
  return { ...body, kind, sessionId };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
