import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { problem, problemMediaType } from "./problems.js";
import { createServiceRuntime, expectedManifestHeader, manifestHeader, ServiceBootError, serviceRoutes, } from "./runtime.js";
import { createFileServiceState } from "./service-state.js";
export { createServiceRuntime, expectedManifestHeader, formCallResultSchemas, formCallTimeoutSeconds, manifestHeader, maxOptionsPerCall, ServiceBootError, serviceRoutes, wireContextSchema, } from "./runtime.js";
export { computeManifestHash } from "./manifest-hash.js";
export { sdkPackageVersion } from "./package-version.js";
export { createFileServiceState, createMemoryServiceState, defaultStateFile, maxStateKeyLength, stateFileInWorkspace, unavailableServiceState, } from "./service-state.js";
export const gatewayKeyHeader = 'x-opsiforce-gate';
export const maxRequestBytes = 48 * 1024 * 1024;
function digest(value) {
    return createHash('sha256').update(value).digest();
}
export function gatewayKeyMatches(presented, expected) {
    return timingSafeEqual(digest(presented ?? ''), digest(expected)) && presented !== undefined && presented !== '';
}
class RequestTooLarge extends Error {
}
async function readBody(request) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        size += chunk.length;
        if (size > maxRequestBytes)
            throw new RequestTooLarge();
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}
function callIdOf(body) {
    const context = body?.context;
    return typeof context?.callId === 'string' ? context.callId : undefined;
}
function routeOf(method, pathname) {
    if (pathname === '/_service/health')
        return method === 'GET' ? { route: 'health' } : undefined;
    if (method !== 'POST')
        return undefined;
    if (pathname === '/_service/inbound')
        return { route: 'inbound' };
    const match = /^\/_service\/([a-z]+)\/([^/]+)$/.exec(pathname);
    const [, route, name] = match ?? [];
    if (!route || !name || route === 'inbound' || !serviceRoutes.includes(route)) {
        return undefined;
    }
    return { route: route, name: decodeURIComponent(name) };
}
export function createServiceServer(options) {
    const gatewayKey = options.gatewayKey ?? process.env.SERVICE_GATEWAY_API_KEY ?? '';
    if (gatewayKey === '') {
        throw new ServiceBootError('The service cannot start: SERVICE_GATEWAY_API_KEY is not set');
    }
    const state = createFileServiceState(options.stateFile);
    const runtime = createServiceRuntime({ ...options, state: options.state ?? (() => state) });
    const stamp = { [manifestHeader]: runtime.manifestHash };
    const send = (response, status, headers, body) => {
        response.writeHead(status, { ...headers, ...stamp, 'content-length': String(body.byteLength) });
        response.end(body);
    };
    const sendProblem = (response, body) => send(response, body.status, { 'content-type': problemMediaType }, Buffer.from(JSON.stringify(body)));
    const handle = async (request, response, seen) => {
        const presented = request.headers[gatewayKeyHeader];
        if (!gatewayKeyMatches(Array.isArray(presented) ? presented[0] : presented, gatewayKey)) {
            request.resume();
            return sendProblem(response, problem({ status: 401, code: 'unauthorized', detail: `Missing or wrong ${gatewayKeyHeader}.` }));
        }
        const url = new URL(request.url ?? '/', 'http://service.local');
        const target = routeOf(request.method ?? 'GET', url.pathname);
        if (!target) {
            request.resume();
            return sendProblem(response, problem({ status: 404, code: 'unknown-route', detail: `No route ${url.pathname}.` }));
        }
        if (target.route === 'health') {
            return send(response, 200, { 'content-type': 'application/json' }, Buffer.from(JSON.stringify(runtime.health())));
        }
        let raw;
        try {
            raw = await readBody(request);
        }
        catch (error) {
            if (error instanceof RequestTooLarge) {
                return sendProblem(response, problem({ status: 413, code: 'request-too-large', detail: `Requests are at most ${maxRequestBytes} bytes.` }));
            }
            throw error;
        }
        let body;
        try {
            body = JSON.parse(raw.toString('utf8'));
        }
        catch {
            return sendProblem(response, problem({ status: 400, code: 'invalid-request', detail: 'The body is not JSON.' }));
        }
        seen.callId = callIdOf(body);
        const aborted = new AbortController();
        response.on('close', () => {
            if (!response.writableFinished)
                aborted.abort();
        });
        const expected = request.headers[expectedManifestHeader];
        const answer = await runtime.dispatch({
            route: target.route,
            name: target.name,
            body,
            signal: aborted.signal,
            expectedManifestHash: Array.isArray(expected) ? expected[0] : expected,
        });
        if (!response.destroyed)
            send(response, answer.status, answer.headers, answer.body);
    };
    const server = createServer((request, response) => {
        const seen = {};
        handle(request, response, seen).catch(() => {
            if (!response.headersSent) {
                sendProblem(response, problem({ status: 502, code: 'service-failed', detail: 'The service failed.', callId: seen.callId }));
            }
            else {
                response.destroy();
            }
        });
    });
    return { server, runtime };
}
