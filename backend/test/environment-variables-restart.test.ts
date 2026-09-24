import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { EnvironmentVariablesService } from '../src/project-environment/environment-variables.service';
import type { ProjectEnvironmentService } from '../src/project-environment/project-environment.service';
import type { PodService } from '../src/pod/pod.service';

const CONTROL_TOKEN = 'control-token';

let agentControl: Server | undefined;

afterEach(() => {
  agentControl?.close();
  agentControl = undefined;
});

async function agentControlAnswering(killed: number): Promise<number> {
  const server = createServer((request, response) => {
    const authorized = request.headers['x-control-token'] === CONTROL_TOKEN;
    response.writeHead(authorized ? 200 : 403, { 'content-type': 'application/json' });
    response.end(authorized ? JSON.stringify({ killed }) : 'forbidden');
  });
  agentControl = server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

function serviceFor(controlPort: number): EnvironmentVariablesService {
  const config = {
    getOrThrow: (key: string) =>
      ({ storageMountPath: mkdtempSync(join(tmpdir(), 'env-vars-')), agentControlPort: controlPort })[key],
  } as unknown as ConfigService;
  const environments = {
    findById: async (id: string) => ({ id, projectId: 'project-1', podIp: '127.0.0.1', directory: 'project-1' }),
  } as unknown as ProjectEnvironmentService;
  const pods = {
    assignedPodName: (id: string) => `pod-${id}`,
    getPod: async () => ({
      spec: { containers: [{ name: 'agent', env: [{ name: 'OPSIFORCE_CONTROL_TOKEN', value: CONTROL_TOKEN }] }] },
    }),
  } as unknown as PodService;
  return new EnvironmentVariablesService(config, environments, pods);
}

const save = (service: EnvironmentVariablesService) =>
  service.updateVariables('project-1', 'env-1', { variables: { API_KEY: 'k' }, restartApp: true });

describe('saving environment variables with a restart', () => {
  it('restarts the App in place when agent-control restarted a supervised process', async () => {
    const service = serviceFor(await agentControlAnswering(2));

    await expect(save(service)).resolves.toEqual({ ok: true, restart: 'app' });
  });

  it('falls back to recreating the pod when agent-control found nothing to restart', async () => {
    const service = serviceFor(await agentControlAnswering(0));

    await expect(save(service)).resolves.toEqual({ ok: true, restart: 'pod' });
  });
});
