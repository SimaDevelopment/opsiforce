import type { TenantModelProvider } from '~/api/model-providers';
import type { SplitRow } from './traffic-split';

export type Audience = 'agents' | 'apps';

export const AUDIENCES: Audience[] = ['agents', 'apps'];

export const AUDIENCE_LABEL: Record<Audience, string> = {
  agents: 'Agents',
  apps: 'Apps',
};

export const AUDIENCE_DESCRIPTION: Record<Audience, string> = {
  agents: 'Requests from the coding Agent that builds each Project.',
  apps: 'Requests from the AI features inside the apps your Projects build.',
};

export interface Routing {
  chatEnabled: boolean;
  chatWeight: number;
  backendEnabled: boolean;
  backendWeight: number;
}

export function routingOf(row: TenantModelProvider): Routing {
  return {
    chatEnabled: row.chatEnabled,
    chatWeight: row.chatWeight,
    backendEnabled: row.backendEnabled,
    backendWeight: row.backendWeight,
  };
}

export function sameRouting(a: Routing, b: Routing): boolean {
  return (
    a.chatEnabled === b.chatEnabled &&
    a.chatWeight === b.chatWeight &&
    a.backendEnabled === b.backendEnabled &&
    a.backendWeight === b.backendWeight
  );
}

export function splitRowOf(row: TenantModelProvider, routing: Routing, audience: Audience): SplitRow {
  return audience === 'apps'
    ? { name: row.name, status: row.status, enabled: routing.backendEnabled, weight: routing.backendWeight }
    : { name: row.name, status: row.status, enabled: routing.chatEnabled, weight: routing.chatWeight };
}

export function withAudienceSwitch(
  routing: Routing,
  audience: Audience,
  next: Partial<Pick<SplitRow, 'enabled' | 'weight'>>
): Routing {
  const [enabledField, weightField] =
    audience === 'apps' ? (['backendEnabled', 'backendWeight'] as const) : (['chatEnabled', 'chatWeight'] as const);
  return {
    ...routing,
    ...(next.enabled !== undefined && { [enabledField]: next.enabled }),
    ...(next.weight !== undefined && { [weightField]: next.weight }),
  };
}

export type DirtyAudiences = Record<Audience, boolean>;
