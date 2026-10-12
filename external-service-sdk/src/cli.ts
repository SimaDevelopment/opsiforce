#!/usr/bin/env node
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { formatCheck } from './check-output.ts';
import { generate } from './cli-generate.ts';
import { report } from './cli-report.ts';
import { dev, serve } from './cli-serve.ts';
import { typesFileName } from './codegen.ts';
import { checkServiceFolder } from './service-folder.ts';
import { writeServiceTypes } from './types-file.ts';

const USAGE = `external-service-cli: tools for an External Service folder

Usage:
  external-service-cli check [folder] [--built-in]            Check the folder's service.json (default: the current folder)
  external-service-cli types [folder] [--built-in]            Write service.types.ts from the folder's service.json
  external-service-cli dev [folder] [--port N] [--built-in]   Serve the folder and reload on every change (Development)
  external-service-cli serve [folder] [--port N] [--built-in] Serve the folder without reloading (Production)
  external-service-cli report [folder] --from <lines.json> [--out <path>]
                                                              Write the test report the Publish dialog reads
                                                              (default: /workspace/.cache/service-test-report.json)
  external-service-cli generate --from-openapi <file|URL> [folder] [--built-in]
                                                              Write service.json, openapi-routes.json and
                                                              service.types.ts from an OpenAPI 3 document
  external-service-cli --help                                 Show this message

check prints every error and warning and exits 1 when there is an error.
dev and serve answer the /_service wire on --port (default: $APP_PORT, else 3000) and need SERVICE_GATEWAY_API_KEY.
dev also rewrites service.types.ts whenever service.json changes.
report reads {"lines": [{expectation, result, source, callIds, reason?}]}, stamps the commit and manifest hash,
and refuses a malformed report without writing it.
generate makes one Operation per route (only the routes marked x-opsiforce-operation, when any is), its input
the route's path, query and body fields in one object, its kind from the method (GET read, DELETE destructive,
others write) unless x-opsiforce-kind says otherwise. It keeps an existing service.json apart from its
operations and $defs, and fails without writing when two routes or two fields share a name.
--built-in applies the Built-in External Service rules (every Event type bound).
`;

function folderArgs(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { 'built-in': { type: 'boolean', default: false } },
  });
  return {
    folder: resolve(positionals[0] ?? '.'),
    origin: values['built-in'] ? ('built_in' as const) : ('custom' as const),
  };
}

async function check(args: string[]): Promise<number> {
  const { folder, origin } = folderArgs(args);
  const result = await checkServiceFolder(folder, { origin });
  process.stdout.write(formatCheck(result));
  return result.ok ? 0 : 1;
}

async function types(args: string[]): Promise<number> {
  const { folder, origin } = folderArgs(args);
  const result = await writeServiceTypes(folder, origin);
  if (!result.ok) {
    process.stdout.write(formatCheck(result.check));
    return 1;
  }
  process.stdout.write(result.changed ? `wrote ${typesFileName}\n` : `${typesFileName} is up to date\n`);
  return 0;
}

const commands: Record<string, (args: string[]) => Promise<number>> = { check, types, generate, dev, serve, report };

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
