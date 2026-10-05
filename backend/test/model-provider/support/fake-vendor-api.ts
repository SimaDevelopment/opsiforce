import { createServer, type IncomingHttpHeaders } from 'node:http';
import { type AddressInfo } from 'node:net';

export type FakeVendorReply = 'models' | 'redirect' | 'drop' | number;

export interface RecordedVendorRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
}

export interface FakeVendorApi {
  baseUrl: string;
  servedOverHttpsAt: (hostname: string) => string;
  requests: RecordedVendorRequest[];
  replyWith: (reply: FakeVendorReply) => void;
  close: () => Promise<void>;
}

export const VENDOR_REPLY_MARKER = 'vendor-reply-body-must-not-reach-the-browser';

export const REDIRECT_TARGET_PATH = '/v1/redirected-models';

export async function startFakeVendorApi(): Promise<FakeVendorApi> {
  const requests: RecordedVendorRequest[] = [];
  let reply: FakeVendorReply = 'models';

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://fake-vendor').pathname;
    requests.push({ method: req.method ?? 'GET', path, headers: req.headers });
    if (reply === 'drop') {
      req.socket.destroy();
      return;
    }
    if (reply === 'redirect' && path !== REDIRECT_TARGET_PATH) {
      res.writeHead(302, { location: REDIRECT_TARGET_PATH });
      res.end(VENDOR_REPLY_MARKER);
      return;
    }
    const status = typeof reply === 'number' ? reply : 200;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: VENDOR_REPLY_MARKER }], error: VENDOR_REPLY_MARKER }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  const httpsHostnames = new Set<string>();
  const unroutedFetch = globalThis.fetch;
  const routedFetch: typeof fetch = (input, init) => {
    const target = new URL(input instanceof Request ? input.url : String(input));
    if (target.protocol !== 'https:' || !httpsHostnames.has(target.hostname)) return unroutedFetch(input, init);
    target.protocol = 'http:';
    target.host = `127.0.0.1:${port}`;
    return unroutedFetch(target, init);
  };

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    servedOverHttpsAt: (hostname) => {
      httpsHostnames.add(hostname);
      globalThis.fetch = routedFetch;
      return `https://${hostname}/v1`;
    },
    requests,
    replyWith: (next) => {
      reply = next;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        if (globalThis.fetch === routedFetch) globalThis.fetch = unroutedFetch;
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
