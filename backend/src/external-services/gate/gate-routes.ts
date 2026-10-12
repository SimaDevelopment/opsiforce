import { manifestLimits } from '@opsiforce/external-service-sdk/platform';

export const GATE_MOUNT = 'external-services/agent';

export const GATE_ROUTE_PREFIX = `/api/${GATE_MOUNT}/`;

export const GATE_BODY_LIMIT = manifestLimits.maxOperationInputBytes;

export const GATE_RESPONSE_LIMIT = 25 * 1024 * 1024;

export const VIA_HEADER = 'x-opsiforce-via';

export type GateVia = 'agent' | 'app';

export function viaOf(header: string | string[] | undefined): GateVia {
  const value = Array.isArray(header) ? header[0] : header;
  return value?.trim().toLowerCase() === 'app' ? 'app' : 'agent';
}

export function bearerTokenOf(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value?.startsWith('Bearer ')) return null;
  const token = value.slice('Bearer '.length).trim();
  return token === '' ? null : token;
}
