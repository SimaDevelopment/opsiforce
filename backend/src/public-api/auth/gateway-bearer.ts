import { CALL_TOKEN_PREFIX } from '../../gateway/call-tokens';

export const GATEWAY_TOKEN_PREFIX = 'gw-';

const BEARER_PREFIX = 'Bearer ';

export type PodBearer = { kind: 'gateway-key'; token: string } | { kind: 'call-token'; token: string };

export function gatewayBearerOf(headers: Record<string, string | string[] | undefined>): string | null {
  const bearer = podBearerOf(headers);
  return bearer?.kind === 'gateway-key' ? bearer.token : null;
}

export function podBearerOf(headers: Record<string, string | string[] | undefined>): PodBearer | null {
  const raw = headers['authorization'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value?.startsWith(BEARER_PREFIX)) return null;

  const token = value.slice(BEARER_PREFIX.length).trim();
  if (token.startsWith(GATEWAY_TOKEN_PREFIX)) return { kind: 'gateway-key', token };
  if (token.startsWith(CALL_TOKEN_PREFIX)) return { kind: 'call-token', token };
  return null;
}
