export interface PreviewLocation {
  path: string;
  canGoBack: boolean;
  canGoForward: boolean;
}

export type PreviewMessage = { type: 'location'; location: PreviewLocation } | { type: 'acknowledged' };

type PreviewCommand = 'reload' | 'back' | 'forward';

const MESSAGE_PREFIX = 'opsiforce-preview:';

export function previewOrigin(environmentId: string): string {
  return `https://${environmentId}.${import.meta.env.VITE_WEBAPP_PREVIEW_DOMAIN}`;
}

export function previewMessageFrom(
  event: MessageEvent,
  frame: HTMLIFrameElement,
  origin: string
): PreviewMessage | null {
  if (event.source !== frame.contentWindow || event.origin !== origin) return null;
  const data: unknown = event.data;
  if (typeof data !== 'object' || data === null || !('type' in data)) return null;
  if (data.type === `${MESSAGE_PREFIX}acknowledged`) return { type: 'acknowledged' };
  if (data.type !== `${MESSAGE_PREFIX}location`) return null;
  if (!('href' in data) || typeof data.href !== 'string' || !URL.canParse(data.href)) return null;
  return {
    type: 'location',
    location: {
      path: pathOf(new URL(data.href)),
      canGoBack: 'canGoBack' in data && data.canGoBack === true,
      canGoForward: 'canGoForward' in data && data.canGoForward === true,
    },
  };
}

export function sendPreviewCommand(frame: HTMLIFrameElement, origin: string, command: PreviewCommand) {
  frame.contentWindow?.postMessage({ type: `${MESSAGE_PREFIX}${command}` }, origin);
}

export function typedPath(typed: string, knownHosts: string[]): string {
  const text = typed.trim();
  if (/^https?:\/\//i.test(text) && URL.canParse(text)) return pathOf(new URL(text));
  const host = knownHosts.find((known) => text === known || text.startsWith(`${known}/`));
  const rest = host ? text.slice(host.length) : text;
  const relative = /^[/?#]/.test(rest) ? rest : `/${rest}`;
  return pathOf(new URL(`https://preview.invalid${relative}`));
}

function pathOf(url: URL): string {
  return `${url.pathname}${url.search}${url.hash}`;
}
