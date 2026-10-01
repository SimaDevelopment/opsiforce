#!/usr/bin/env node
import { startServer } from './server.ts';

const USAGE = `linked-account-proxy — stateless model proxy for Linked accounts

Usage:
  linked-account-proxy            Start the proxy server (default)
  linked-account-proxy --help     Show this message
`;

async function main(): Promise<void> {
  const command = process.argv[2];

  if (command === '--help' || command === '-h') {
    process.stdout.write(USAGE);
    return;
  }
  if (command === undefined || command === 'serve' || command === 'start') {
    startServer();
    return;
  }

  process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`linked-account-proxy error: ${message}\n`);
  process.exitCode = 1;
});
