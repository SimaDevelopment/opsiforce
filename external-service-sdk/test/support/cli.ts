import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageJsonPath = fileURLToPath(import.meta.resolve('@opsiforce/external-service-sdk/package.json'));
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { bin: Record<string, string> };
const cliPath = resolve(dirname(packageJsonPath), packageJson.bin['external-service-cli'] ?? '');

export interface CliRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

export function runCli(args: string[], env: Record<string, string | undefined> = {}): CliRun {
  const run = spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

export interface RunningCli {
  output(): string;
  waitFor(pattern: RegExp, timeoutMs?: number): Promise<RegExpMatchArray>;
  exited(): Promise<number | null>;
  stop(): Promise<number | null>;
}

export function startCli(args: string[], env: Record<string, string | undefined> = {}): RunningCli {
  const child = spawn(process.execPath, [cliPath, ...args], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let consumed = 0;
  const listeners = new Set<() => void>();
  const append = (chunk: Buffer) => {
    output += chunk.toString('utf8');
    for (const listener of listeners) listener();
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  const exit = new Promise<number | null>((resolveExit) => child.on('exit', (code) => resolveExit(code)));

  return {
    output: () => output,
    waitFor(pattern, timeoutMs = 15_000) {
      return new Promise((resolveMatch, reject) => {
        const look = () => {
          const match = pattern.exec(output.slice(consumed));
          if (!match) return false;
          consumed += (match.index ?? 0) + match[0].length;
          listeners.delete(onOutput);
          clearTimeout(timer);
          resolveMatch(match);
          return true;
        };
        const onOutput = () => void look();
        const timer = setTimeout(() => {
          listeners.delete(onOutput);
          reject(new Error(`timed out waiting for ${pattern}; output so far:\n${output}`));
        }, timeoutMs);
        listeners.add(onOutput);
        look();
      });
    },
    exited: () => exit,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      return exit;
    },
  };
}
