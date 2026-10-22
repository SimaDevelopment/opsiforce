import {
  defineService,
  upstream,
  type DefinedService,
  type Route,
  type ServiceDefinition,
} from '@opsiforce/external-service-sdk';

import type { JsonObject } from './fixtures.ts';

export function githubManifest(): JsonObject {
  return {
    sdk: 2,
    displayName: 'GitHub',
    description: 'Issues and pull requests on the repositories a Project is given.',
    inbound: true,
    serviceForm: [
      { key: 'appId', type: 'text', label: 'App id', required: true },
      { key: 'privateKey', type: 'secret', label: 'Private key', required: true },
    ],
    projectForm: [
      {
        key: 'repositories',
        type: 'list',
        label: 'Repositories',
        item: [
          { key: 'repositoryId', type: 'text', label: 'Repository', required: true },
          {
            key: 'access',
            type: 'select',
            label: 'Access',
            default: 'read',
            options: [
              { value: 'read', label: 'Read' },
              { value: 'pull_request', label: 'Pull request' },
              { value: 'write', label: 'Write' },
            ],
          },
        ],
      },
      { key: 'coAuthor', type: 'text', label: 'Co-author trailer' },
      { key: 'apiToken', type: 'secret', label: 'API token' },
    ],
    events: {
      'issue.opened': { title: 'Issue opened', description: 'Someone opened an issue in a repository.' },
    },
  };
}

export const privateKey = 'super-secret-private-key-123';

export const serviceConfiguration = { appId: '1', privateKey };

export const projectConfiguration = {
  repositories: [{ id: 'r1', repositoryId: 'acme/web', access: 'write' }],
};

export function definedWith(
  routes: readonly Route[],
  definition: Partial<Omit<ServiceDefinition, 'routes'>> = {}
): DefinedService {
  return defineService({ manifest: githubManifest(), routes, ...definition });
}

export const rest = upstream({
  name: 'rest',
  api: 'GitHub REST API',
  url: 'https://api.github.com',
  mount: '/api/v3',
});

export function recordedUpstream(answer: (request: Request) => Response = () => Response.json({ ok: true })) {
  const requests: Request[] = [];
  return {
    requests,
    fake: (request: Request) => {
      requests.push(request);
      return answer(request);
    },
  };
}

export interface RefusalSeen {
  status: number;
  outcome: string | null;
  setting: string | null;
  body: { outcome: string; message: string; setting: string | null; link: string | null };
}

export async function refusalSeen(answer: Response): Promise<RefusalSeen> {
  return {
    status: answer.status,
    outcome: answer.headers.get('opsiforce-outcome'),
    setting: answer.headers.get('opsiforce-setting'),
    body: (await answer.json()) as RefusalSeen['body'],
  };
}
