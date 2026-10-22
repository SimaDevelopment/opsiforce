#!/usr/bin/env node
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { formatCheck } from './check-output.ts';
import { report } from './cli-report.ts';
import { dev, serve } from './cli-serve.ts';
import { typesFileName } from './codegen.ts';
import { checkServiceFolder } from './service-folder.ts';
import { writeServiceTypes } from './types-file.ts';

const USAGE = `external-service-cli: tools for an External Service folder

Usage:
  external-service-cli check [folder]              Check the folder's service.json (default: the current folder)
  external-service-cli types [folder]              Write service.types.ts from the folder's service.json
  external-service-cli dev [folder] [--port N]     Serve the folder and reload on every change (Development)
  external-service-cli serve [folder] [--port N]   Serve the folder without reloading (Production)
  external-service-cli report [folder] --from <lines.json> [--out <path>]
                                                   Write the test report the Publish dialog reads
                                                   (default: /workspace/.cache/service-test-report.json)
  external-service-cli --help                      Show this message

check prints every error and warning and exits 1 when there is an error.
dev and serve serve service.ts's defineService(…) on --port (default: $APP_PORT, else 3000): its Service routes
and /.well-known/opsiforce, for requests carrying a Caller identity signed with SERVICE_GATEWAY_API_KEY.
They read their configurations from $SERVICE_GATEWAY_URL.
dev also rewrites service.types.ts whenever service.json changes.
report reads {"lines": [{expectation, result, source, callIds, reason?}]}, stamps the commit and manifest hash,
and refuses a malformed report without writing it.
`;

function folderOf(args: string[]): string {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  return resolve(positionals[0] ?? '.');
}

async function check(args: string[]): Promise<number> {
  const result = await checkServiceFolder(folderOf(args));
  process.stdout.write(formatCheck(result));
  return result.ok ? 0 : 1;
}

async function types(args: string[]): Promise<number> {
  const result = await writeServiceTypes(folderOf(args));
  if (!result.ok) {
    process.stdout.write(formatCheck(result.check));
    return 1;
  }
  process.stdout.write(result.changed ? `wrote ${typesFileName}\n` : `${typesFileName} is up to date\n`);
  return 0;
}

const commands: Record<string, (args: string[]) => Promise<number>> = { check, types, dev, serve, report };

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);
  if (command === undefined || command === '--help' || command === '-h') {
    process.stdout.write(USAGE);
    return command === undefined ? 2 : 0;
  }
  const run = commands[command];
  if (!run) {
    process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
    return 2;
  }
  return run(args);
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(`external-service-cli: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
