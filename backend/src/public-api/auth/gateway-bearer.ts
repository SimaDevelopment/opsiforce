import { callerIdentityHeader } from '@opsiforce/external-service-sdk/server';

export const GATEWAY_TOKEN_PREFIX = 'gw-';

const BEARER_PREFIX = 'Bearer ';

export type PodCredential = { kind: 'gateway-key'; token: string } | { kind: 'caller-identity'; token: string };

type Headers = Record<string, string | string[] | undefined>;

function firstOf(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function gatewayBearerOf(headers: Headers): string | null {
  const value = firstOf(headers['authorization']);
  if (!value?.startsWith(BEARER_PREFIX)) return null;
  const token = value.slice(BEARER_PREFIX.length).trim();
  return token.startsWith(GATEWAY_TOKEN_PREFIX) ? token : null;
}

export function podCredentialOf(headers: Headers): PodCredential | null {
  const callerIdentity = firstOf(headers[callerIdentityHeader]);
  if (callerIdentity !== undefined) return { kind: 'caller-identity', token: callerIdentity };
  const gatewayKey = gatewayBearerOf(headers);
  return gatewayKey === null ? null : { kind: 'gateway-key', token: gatewayKey };
}
