import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { brotliCompressSync, deflateSync, gzipSync, zstdCompressSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchAsLocalhost } from '../src/pod/pod-fetch';

interface Seen {
  method: string;
  path: string;
  host: string;
  body: string;
}

let app: Server | undefined;

afterEach(() => {
  app?.close();
  app = undefined;
});

async function read(request: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of request) body += chunk;
  return body;
}

async function appThatRedirects(): Promise<{ url: (path: string) => URL; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer(async (request, response) => {
    const body = await read(request);
    const host = request.headers.host ?? '';
    seen.push({ method: request.method ?? '', path: request.url ?? '', host, body });
    const redirects: Record<string, [number, string]> = {
      '/api/job': [307, '/api/job/'],
      '/api/moved': [308, `http://${host}/api/job/`],
      '/api/form': [303, '/api/job/'],
      '/api/legacy': [302, '/api/job/'],
      '/api/elsewhere': [302, 'http://example.org/'],
    };
    if (request.url === '/api/hang') return;
    if (request.url === '/api/slow-body') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.write('first ');
      setTimeout(() => response.end('second'), 100);
      return;
    }
    if (request.url === '/api/odd-status') {
      response.writeHead(600);
      response.end();
      return;
    }
    const encoding = request.url?.match(/^\/api\/compressed\/(.+)$/)?.[1];
    if (encoding) {
      response.writeHead(200, { 'content-type': 'application/json', 'content-encoding': encoding });
      response.end(compressors[encoding](Buffer.from(JSON.stringify({ ok: true }))));
      return;
    }
    const redirect = redirects[request.url ?? ''];
    if (redirect) {
      response.writeHead(redirect[0], { location: redirect[1] });
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end(`${request.method} ${body}`);
  });
  app = server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: (path) => new URL(`http://127.0.0.1:${port}${path}`), seen };
}

const compressors: Record<string, (body: Buffer) => Buffer> = {
  gzip: gzipSync,
  deflate: deflateSync,
  br: brotliCompressSync,
  zstd: zstdCompressSync,
};

const post = { method: 'POST', body: 'payload', headers: { 'content-type': 'text/plain' } };

describe('calling an App on its pod', () => {
  it('follows a relative redirect and keeps the POST and its body on a 307', async () => {
    const { url, seen } = await appThatRedirects();

    const response = await fetchAsLocalhost(url('/api/job'), post);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('POST payload');
    expect(seen[1]).toMatchObject({ method: 'POST', path: '/api/job/', host: `localhost:${url('/').port}` });
  });

  it('follows an absolute redirect to localhost back to the same pod', async () => {
    const { url, seen } = await appThatRedirects();

    const response = await fetchAsLocalhost(url('/api/moved'));

    expect(response.status).toBe(200);
    expect(seen.map((request) => request.path)).toEqual(['/api/moved', '/api/job/']);
  });

  it('turns a 303 into a GET without the body', async () => {
    const { url, seen } = await appThatRedirects();

    const response = await fetchAsLocalhost(url('/api/form'), post);

    expect(await response.text()).toBe('GET ');
    expect(seen[1]).toMatchObject({ method: 'GET', body: '' });
  });

  it('turns a POST answered with a 302 into a GET', async () => {
    const { url, seen } = await appThatRedirects();

    await fetchAsLocalhost(url('/api/legacy'), post).then((response) => response.text());

    expect(seen[1]).toMatchObject({ method: 'GET', path: '/api/job/' });
  });

  it('refuses to follow a redirect off the pod', async () => {
    const { url, seen } = await appThatRedirects();

    await expect(fetchAsLocalhost(url('/api/elsewhere'))).rejects.toMatchObject({
      cause: { message: expect.stringContaining('example.org') },
    });
    expect(seen).toHaveLength(1);
  });

  it("gives up at the caller's deadline when the App never answers", async () => {
    const { url } = await appThatRedirects();

    await expect(fetchAsLocalhost(url('/api/hang'), { signal: AbortSignal.timeout(50) })).rejects.toMatchObject({
      name: 'TimeoutError',
    });
  });

  it('passes on a status outside 200–599 without crashing the backend', async () => {
    const { url } = await appThatRedirects();

    expect((await fetchAsLocalhost(url('/api/odd-status'))).status).toBe(600);
    expect((await fetchAsLocalhost(url('/api/job/'))).status).toBe(200);
  });

  it.each(Object.keys(compressors))('decodes a %s-compressed answer', async (encoding) => {
    const { url } = await appThatRedirects();

    const response = await fetchAsLocalhost(url(`/api/compressed/${encoding}`));

    expect(await response.json()).toEqual({ ok: true });
  });

  it('delivers the whole body when the App is still sending it after the call returns', async () => {
    const { url } = await appThatRedirects();

    const response = await fetchAsLocalhost(url('/api/slow-body'));

    expect(await response.text()).toBe('first second');
  });

  it('returns the redirect itself when asked not to follow', async () => {
    const { url, seen } = await appThatRedirects();

    const response = await fetchAsLocalhost(url('/api/job'), { ...post, redirect: 'manual' });

    expect(response.status).toBe(307);
    expect(seen).toHaveLength(1);
  });
});
