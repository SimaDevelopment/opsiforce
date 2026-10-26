import type { ServerResponse } from 'node:http';
import { MODEL_CATALOG } from './chatgpt/config.ts';
import { forwardChatCompletionsToChatGpt } from './chatgpt/forward-chat-completions.ts';
import { forwardImagesToChatGpt } from './chatgpt/forward-images.ts';
import { forwardToChatGpt } from './chatgpt/forward.ts';
import type { CallerAccess } from './credentials.ts';
import type { JsonRecord } from './http.ts';
import type { ImagesRequest } from './images.ts';

export type VendorForward<Request = JsonRecord> = (
  request: Request,
  res: ServerResponse,
  access: CallerAccess
) => Promise<void>;

export interface ProxyVendorAdapter {
  models: readonly string[];
  forward: VendorForward;
  forwardChatCompletions: VendorForward;
  forwardImages: VendorForward<ImagesRequest>;
}

const PROXY_VENDOR_ADAPTERS: Record<string, ProxyVendorAdapter> = {
  chatgpt: {
    models: MODEL_CATALOG,
    forward: forwardToChatGpt,
    forwardChatCompletions: forwardChatCompletionsToChatGpt,
    forwardImages: forwardImagesToChatGpt,
  },
};

export function proxyVendorAdapterOf(vendor: string): ProxyVendorAdapter | undefined {
  return Object.hasOwn(PROXY_VENDOR_ADAPTERS, vendor) ? PROXY_VENDOR_ADAPTERS[vendor] : undefined;
}
