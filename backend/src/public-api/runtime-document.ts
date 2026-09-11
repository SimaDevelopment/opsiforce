import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import type { OpenAPIObject } from '@nestjs/swagger';
import { RUNTIME_PROXY_PREFIX } from '../common/runtime-urls';

const logger = new Logger('PublicApiDocs');

const RUNTIME_DOCUMENT_FILE = join(process.cwd(), '..', 'frontend', 'opencode', 'packages', 'protocol', 'openapi.json');

const ENVIRONMENT_ID_VARIABLE = 'environmentId';

const RUNTIME_DESCRIPTION = [
  "The Agent runtime's own API — the conversation itself. This is opencode, reached through the runtime proxy, in opencode's own paths, bodies, responses and event framing. Nothing here is re-shaped, filtered or renamed by the platform.",
  '**This document is a snapshot**, vendored from the opencode build this deployment ships, and served by the platform so you can read it without waking an environment. The authoritative document for a *running* environment is the `openapiUrl` that `connect` reports, served by that pod at that build.',
  '**Get here first.** Call `POST /api/v1/projects/{id}/environments/{environmentId}/connect` on the Platform API. It wakes the environment, binds the primary Session every surface shares, and reports the runtime build. Then set the `environmentId` server variable above, and use the Session id that call gave you.',
  '**Two things to know.** `wait` means the Session went idle, not that your prompt succeeded — read the outcome from the messages or the events. And send your own `id` on a prompt so a retry is harmless: the runtime returns the first admission again for the same id and body, and conflicts on a different one.',
  '**The platform does not version this surface.** It is the protocol of the deployed build and moves when the agent image does, so the compatibility policy on the Platform API does not cover it. Treat `@opencode-ai/client` and the runtime as a pairing you verify together.',
].join('\n\n');

function withPlatformDiscovery(document: OpenAPIObject): OpenAPIObject {
  return {
    ...document,
    info: {
      ...document.info,
      title: 'Opsiforce Agent Runtime',
      description: RUNTIME_DESCRIPTION,
    },
    servers: [
      {
        url: `${RUNTIME_PROXY_PREFIX}/{${ENVIRONMENT_ID_VARIABLE}}`,
        description: 'The runtime proxy, on the origin you called the Platform API on',
        variables: {
          [ENVIRONMENT_ID_VARIABLE]: {
            default: 'your-environment-id',
            description: 'Environment to talk to, from a Project environments[] entry or from connect',
          },
        },
      },
    ],
  };
}

export function readRuntimeDocument(): OpenAPIObject | null {
  try {
    const { openapi, info, paths, ...rest } = JSON.parse(
      readFileSync(RUNTIME_DOCUMENT_FILE, 'utf8')
    ) as Partial<OpenAPIObject>;

    if (!openapi || !info || !paths) {
      logger.warn(`Vendored runtime OpenAPI document at ${RUNTIME_DOCUMENT_FILE} is missing openapi, info or paths`);
      return null;
    }

    return withPlatformDiscovery({ ...rest, openapi, info, paths });
  } catch {
    logger.warn(`Vendored runtime OpenAPI document is unreadable at ${RUNTIME_DOCUMENT_FILE}`);
    return null;
  }
}
