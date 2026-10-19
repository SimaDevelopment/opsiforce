import { spawn, type ChildProcess } from 'node:child_process';
import { watch } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { formatCheck } from './check-output.ts';
import { typesFileName } from './codegen.ts';
import { isDefinedService, type DefinedService } from './define-service.ts';
import { computeManifestHash } from './manifest-hash.ts';
import { sdkPackageVersion } from './package-version.ts';
import { createServiceHttpServer } from './service-http-server.ts';
import { manifestFileName, readServiceFolder } from './service-folder.ts';
import { writeServiceTypes } from './types-file.ts';

export const serviceFileName = 'service.ts';
export const defaultServicePort = 3000;

const reloadDelayMs = 150;
const ownExtension = extname(fileURLToPath(import.meta.url));
const ignoredFolders = new Set(['.git', '.yarn', '.cache', 'node_modules']);

interface ServiceArgs {
  folder: string;
  port: number;
}

function parseServiceArgs(args: string[]): ServiceArgs {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { port: { type: 'string' } },
  });
  const rawPort = values.port ?? process.env.APP_PORT ?? String(defaultServicePort);
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error(`--port ${rawPort} is not a port number`);
  return { folder: resolve(positionals[0] ?? '.'), port };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stopOnSignal(stop: () => void): void {
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

async function importDefinedService(folder: string): Promise<DefinedService> {
  const module = (await import(pathToFileURL(join(folder, serviceFileName)).href)) as { default?: unknown };
  if (!isDefinedService(module.default)) {
    throw new Error(`${serviceFileName} has no default export; write export default defineService<Manifest>({ … })`);
  }
  return module.default;
}

async function listen(server: Server, port: number): Promise<number> {
  await new Promise<void>((resolveListen) => server.listen(port, resolveListen));
  return (server.address() as AddressInfo).port;
}

function untilStopped(server: Server, background?: AbortController): Promise<number> {
  return new Promise((resolveExit) => {
    stopOnSignal(() => {
      background?.abort();
      server.close(() => resolveExit(0));
      server.closeAllConnections();
    });
  });
}

export async function serve(args: string[]): Promise<number> {
  const { folder, port } = parseServiceArgs(args);
  const read = await readServiceFolder(folder);
  if (!read.check.ok || !read.check.manifest) {
    process.stdout.write(formatCheck(read.check));
    return 1;
  }

  let started: ReturnType<typeof createServiceHttpServer>;
  let defined: DefinedService;
  try {
    defined = await importDefinedService(folder);
    if (defined.manifestHash !== computeManifestHash(read.json)) {
      throw new Error(`${serviceFileName} defines the service with a manifest other than ${manifestFileName}`);
    }
    started = createServiceHttpServer(defined);
  } catch (error) {
    process.stderr.write(`external-service-cli serve: ${messageOf(error)}\n`);
    return 1;
  }

  const listeningPort = await listen(started.server, port);
  process.stdout.write(
    `${defined.manifest.displayName} listening on port ${listeningPort} (SDK ${sdkPackageVersion}, manifest ${defined.manifestHash.slice(0, 12)})\n`
  );
  const background = new AbortController();
  const { background: run } = defined.definition;
  if (run) {
    Promise.resolve()
      .then(() => run(started.service, background.signal))
      .catch((error: unknown) => process.stderr.write(`background stopped: ${messageOf(error)}\n`));
  }
  return untilStopped(started.server, background);
}

function ignored(filename: string): boolean {
  return filename.split(sep).some((segment) => ignoredFolders.has(segment));
}

export async function dev(args: string[]): Promise<number> {
  const { folder, port } = parseServiceArgs(args);
  const cli = fileURLToPath(new URL(`./cli${ownExtension}`, import.meta.url));
  const serveArgs = [cli, 'serve', folder, '--port', String(port)];

  let typesContent: string | undefined;
  const refreshTypes = async (): Promise<boolean> => {
    const result = await writeServiceTypes(folder);
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
