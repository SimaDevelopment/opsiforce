export const GATEWAY_TOKEN_PREFIX = 'gw-';

const BEARER_PREFIX = 'Bearer ';

export function gatewayBearerOf(headers: Record<string, string | string[] | undefined>): string | null {
  const raw = headers['authorization'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value?.startsWith(BEARER_PREFIX)) return null;

  const token = value.slice(BEARER_PREFIX.length).trim();
  return token.startsWith(GATEWAY_TOKEN_PREFIX) ? token : null;
}
