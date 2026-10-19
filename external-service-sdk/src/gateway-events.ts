import { callerIdentityHeader } from './caller-identity.ts';
import type { DeliveryResult } from './define-service.ts';
import type { EventDelivery } from './service-pipeline.ts';

export const eventsPath = '/events';

export const eventPart = 'event';

export interface GatewayEventsOptions {
  url: string;
  gatewayKey: string;
  fetch?: typeof fetch;
}

export function filePartName(index: number): string {
  return `file-${index}`;
}

export function gatewayEvents(options: GatewayEventsOptions): EventDelivery {
  const send = options.fetch ?? fetch;
  const url = `${options.url.replace(/\/+$/, '')}${eventsPath}`;
  return {
    async deliver(event, to, callerIdentity) {
      const files = event.files ?? [];
      const form = new FormData();
      const envelope = {
        type: event.type,
        key: event.key,
        occurredAt: event.occurredAt,
        data: event.data,
        to,
        files: files.map((file, index) => ({ part: filePartName(index), name: file.name, mimeType: file.mimeType })),
      };
      form.set(eventPart, JSON.stringify(envelope));
      files.forEach((file, index) => {
        form.set(
          filePartName(index),
          new Blob([file.bytes as Uint8Array<ArrayBuffer>], { type: file.mimeType }),
          file.name
        );
      });
      const headers: Record<string, string> = { authorization: `Bearer ${options.gatewayKey}` };
      if (callerIdentity !== undefined) headers[callerIdentityHeader] = callerIdentity;
      const answer = await send(url, { method: 'POST', headers, body: form });
      if (!answer.ok) {
        const text = await answer.text().catch(() => '');
        throw new Error(`the Event delivery answered ${answer.status}${text === '' ? '' : `: ${text.slice(0, 500)}`}`);
      }
      return ((await answer.json()) as { results: DeliveryResult[] }).results;
    },
  };
}
