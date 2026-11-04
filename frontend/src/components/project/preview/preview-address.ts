export interface PreviewLocation {
  path: string;
  canGoBack: boolean;
  canGoForward: boolean;
}

type PreviewCommand = 'reload' | 'back' | 'forward';

const LOCATION_MESSAGE = 'opsiforce-preview:location';

export function previewOrigin(environmentId: string): string {
  return `https://${environmentId}.${import.meta.env.VITE_WEBAPP_PREVIEW_DOMAIN}`;
}

export function previewLocationFrom(
  event: MessageEvent,
  frame: HTMLIFrameElement,
  origin: string
): PreviewLocation | null {
  if (event.source !== frame.contentWindow || event.origin !== origin) return null;
  const data: unknown = event.data;
  if (typeof data !== 'object' || data === null || !('type' in data) || data.type !== LOCATION_MESSAGE) return null;
  if (!('href' in data) || typeof data.href !== 'string' || !URL.canParse(data.href)) return null;
  return {
    path: pathOf(new URL(data.href)),
    canGoBack: 'canGoBack' in data && data.canGoBack === true,
    canGoForward: 'canGoForward' in data && data.canGoForward === true,
  };
}

export function sendPreviewCommand(frame: HTMLIFrameElement, origin: string, command: PreviewCommand) {
  frame.contentWindow?.postMessage({ type: `opsiforce-preview:${command}` }, origin);
}

export function typedPath(typed: string, knownHosts: string[]): string {
  const text = typed.trim();
  if (/^https?:\/\//i.test(text) && URL.canParse(text)) return pathOf(new URL(text));
  const host = knownHosts.find((known) => text === known || text.startsWith(`${known}/`));
  const rest = host ? text.slice(host.length) : text;
  const relative = /^[/?#]/.test(rest) ? rest : `/${rest}`;
  return pathOf(new URL(relative, 'https://preview.invalid'));
}

function pathOf(url: URL): string {
  return `${url.pathname}${url.search}${url.hash}`;
}
