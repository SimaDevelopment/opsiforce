import type { ServerResponse } from 'node:http';
import { MODEL_CATALOG } from './chatgpt/config.ts';
import { forwardToChatGpt } from './chatgpt/forward.ts';
import type { CallerCredentials, LinkedAccountCredential } from './credentials.ts';
import type { JsonRecord } from './http.ts';

export interface ProxyVendorAdapter {
  models: readonly string[];
  forward(
    body: JsonRecord,
    res: ServerResponse,
    credentials: CallerCredentials,
    credential: LinkedAccountCredential
  ): Promise<void>;
}

const PROXY_VENDOR_ADAPTERS: Record<string, ProxyVendorAdapter> = {
  chatgpt: { models: MODEL_CATALOG, forward: forwardToChatGpt },
};

export function proxyVendorAdapterOf(vendor: string): ProxyVendorAdapter | undefined {
  return Object.hasOwn(PROXY_VENDOR_ADAPTERS, vendor) ? PROXY_VENDOR_ADAPTERS[vendor] : undefined;
}
