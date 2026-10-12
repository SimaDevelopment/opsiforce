import { spawn, type ChildProcess } from 'node:child_process';
import { watch } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import type { ServiceOrigin } from './check-manifest.ts';
import { formatCheck } from './check-output.ts';
import { typesFileName } from './codegen.ts';
import type { AnyServiceHandlers } from './handlers.ts';
import { createServiceServer } from './server.ts';
import { manifestFileName, readServiceFolder } from './service-folder.ts';
import { writeServiceTypes } from './types-file.ts';

export const handlersFileName = 'handlers.ts';
export const defaultServicePort = 3000;

const reloadDelayMs = 150;
const ownExtension = extname(fileURLToPath(import.meta.url));
const ignoredFolders = new Set(['.git', '.yarn', '.cache', 'node_modules']);

interface ServiceArgs {
  folder: string;
  origin: ServiceOrigin;
  port: number;
}

function parseServiceArgs(args: string[]): ServiceArgs {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { 'built-in': { type: 'boolean', default: false }, port: { type: 'string' } },
  });
  const rawPort = values.port ?? process.env.APP_PORT ?? String(defaultServicePort);
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error(`--port ${rawPort} is not a port number`);
  return {
    folder: resolve(positionals[0] ?? '.'),
    origin: values['built-in'] ? 'built_in' : 'custom',
    port,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function importHandlers(folder: string): Promise<AnyServiceHandlers> {
  const module = (await import(pathToFileURL(join(folder, handlersFileName)).href)) as { default?: unknown };
  if (typeof module.default !== 'object' || module.default === null) {
    throw new Error(`${handlersFileName} has no default export; write export default defineHandlers<Manifest>({ … })`);
  }
  return module.default as AnyServiceHandlers;
}

function stopOnSignal(stop: () => void): void {
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

export async function serve(args: string[]): Promise<number> {
  const { folder, origin, port } = parseServiceArgs(args);
  const read = await readServiceFolder(folder, { origin });
  if (!read.check.ok || !read.check.manifest) {
    process.stdout.write(formatCheck(read.check));
    return 1;
  }

  let service: ReturnType<typeof createServiceServer>;
  try {
    service = createServiceServer({ manifest: read.json, handlers: await importHandlers(folder), origin });
  } catch (error) {
    process.stderr.write(`external-service-cli serve: ${messageOf(error)}\n`);
    return 1;
  }

  const { server, runtime } = service;
  await new Promise<void>((resolveListen) => server.listen(port, resolveListen));
  const { port: listeningPort } = server.address() as AddressInfo;
  process.stdout.write(
    `${runtime.manifest.displayName} listening on port ${listeningPort} (manifest ${runtime.manifestHash.slice(0, 12)})\n`
  );

  return new Promise((resolveExit) => {
    stopOnSignal(() => {
      server.close(() => resolveExit(0));
      server.closeAllConnections();
    });
  });
}

function ignored(filename: string): boolean {
  return filename.split(sep).some((segment) => ignoredFolders.has(segment));
}

export async function dev(args: string[]): Promise<number> {
  const { folder, origin, port } = parseServiceArgs(args);
  const cli = fileURLToPath(new URL(`./cli${ownExtension}`, import.meta.url));
  const serveArgs = [cli, 'serve', folder, '--port', String(port), ...(origin === 'built_in' ? ['--built-in'] : [])];

  let typesContent: string | undefined;
  const refreshTypes = async (): Promise<boolean> => {
    const result = await writeServiceTypes(folder, origin);
    if (!result.ok) {
      process.stdout.write(formatCheck(result.check));
      process.stdout.write('service.json has errors; the running service keeps the last good one\n');
      return false;
    }
    if (result.changed) process.stdout.write(`wrote ${typesFileName}\n`);
    typesContent = result.content;
    return true;
  };

  let child: ChildProcess | undefined;
  const stopped = new WeakSet<ChildProcess>();
  const startChild = () => {
    const started = spawn(process.execPath, [...process.execArgv, ...serveArgs], { stdio: 'inherit' });
    started.on('exit', (code, signal) => {
      if (stopped.has(started)) return;
      process.stdout.write(`the service stopped (${signal ?? `exit ${code}`}); waiting for a change\n`);
    });
    child = started;
  };
  const stopChild = async () => {
    const running = child;
    child = undefined;
    if (!running || running.exitCode !== null || running.signalCode !== null) return;
    stopped.add(running);
    const exited = new Promise((resolveExit) => running.once('exit', resolveExit));
    running.kill('SIGTERM');
    await exited;
  };

  const changed = new Set<string>();
  const reload = async () => {
    const files = [...changed];
    changed.clear();
    if (files.length === 0) return;
    if (files.includes(manifestFileName) && !(await refreshTypes())) return;
    if (files.every((file) => file === typesFileName)) {
      const current = await readFile(join(folder, typesFileName), 'utf8').catch(() => undefined);
      if (current === typesContent) return;
    }
    process.stdout.write(`restarting: ${files.join(', ')} changed\n`);
    await stopChild();
    startChild();
  };

  await refreshTypes();
  let queue = Promise.resolve();
  let timer: NodeJS.Timeout | undefined;
  const watcher = watch(folder, { recursive: true }, (_event, filename) => {
    if (!filename || ignored(filename)) return;
    changed.add(filename.split(sep).join('/'));
    clearTimeout(timer);
    timer = setTimeout(() => {
      queue = queue.then(reload).catch((error: unknown) => {
        process.stderr.write(`external-service-cli dev: ${messageOf(error)}\n`);
      });
    }, reloadDelayMs);
  });
  process.once('exit', () => child?.kill('SIGTERM'));
  startChild();

  return new Promise((resolveExit) => {
    const shutDown = (code: number) => {
      watcher.close();
      clearTimeout(timer);
      void queue.then(stopChild).then(() => resolveExit(code));
    };
    watcher.on('error', (error) => {
      process.stderr.write(`external-service-cli dev: cannot watch ${folder}: ${messageOf(error)}\n`);
      shutDown(1);
    });
    stopOnSignal(() => shutDown(0));
  });
}
