import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FALLBACK_APP_PORT, agentAppPort, sharedAppPort, readMergedAgentRegistry } from '../src/agent/agent-config';
import { buildPodSpec, type PodTemplateOptions } from '../src/pod/pod.template';
import { resolvePreset, toK8sResources } from '../src/pod/pod-classes';

const agentConfig = join(process.cwd(), '..', 'agent-config');
const entrypoint = readFileSync(join(agentConfig, 'scripts', 'entrypoint.sh'), 'utf8');
const podTemplate = readFileSync(join(process.cwd(), 'src', 'pod', 'pod.template.ts'), 'utf8');
const platformSkill = readFileSync(join(agentConfig, 'skills', 'platform', 'SKILL.md'), 'utf8');

function withoutCodeBlocks(markdown: string): string {
  return markdown.replaceAll(/^```[\s\S]*?^```/gm, '');
}

function environmentVariablesNamedIn(markdown: string): string[] {
  const spans = withoutCodeBlocks(markdown).match(/`[^`\n]+`/g) ?? [];
  const names = spans.map((span) => span.slice(1, -1)).filter((span) => /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(span));
  return [...new Set(names)].toSorted();
}

function baseOptions(overrides: Partial<PodTemplateOptions> = {}): PodTemplateOptions {
  return {
    podName: 'opsiforce-agent-test',
    namespace: 'opsiforce',
    agentContainerImage: 'opsiforce-agent:test',
    agentPort: 4096,
    storageType: 'hostPath',
    cephfsPvcName: 'opsiforce-cephfs',
    storageMountPath: '/workspace-data',
    imagePullPolicy: 'IfNotPresent',
    resources: toK8sResources(resolvePreset('small')),
    ...overrides,
  };
}

function environmentOf(spec: ReturnType<typeof buildPodSpec>): Map<string, string> {
  const env = spec.spec?.containers[0].env ?? [];
  return new Map(env.map((entry) => [entry.name, entry.value ?? '']));
}

describe('the platform skill', () => {
  it('is shipped by the image as a shared skill', () => {
    expect(platformSkill).toMatch(/^name: platform$/m);
  });

  it('names the port variable and the go-live file in its description, the only part read unloaded', () => {
    const [, description] = /^description: (.+)$/m.exec(platformSkill) ?? [];

    expect(description).toBeDefined();
    expect(description).toContain('APP_PORT');
    expect(description).toContain('app.meta.json');
  });

  it('names only environment variables the pod actually sets', () => {
    const named = environmentVariablesNamedIn(platformSkill);

    expect(named).toContain('APP_PORT');
    expect(named).toContain('APP_PUBLIC_URL');
    expect(named).toContain('OPSIFORCE_ENV');
    expect(named).toContain('SERVICE_GATEWAY_URL');
    expect(named).toContain('SERVICE_GATEWAY_API_KEY');
    expect(named).toContain('EXTERNAL_SERVICES_URL');
    expect(named).toContain('APP_LLM_BASE_URL');
    expect(named).toContain('APP_LLM_API_KEY');

    const unset = named.filter((name) => !podTemplate.includes(name) && !entrypoint.includes(name));
    expect(unset).toEqual([]);
  });

  it('states the whole App contract', () => {
    expect(platformSkill).toContain('/workspace/app/startup.sh');
    expect(platformSkill).toContain('/workspace/app/app.meta.json');
    expect(platformSkill).toContain('/workspace/user_uploaded_files/');
    expect(platformSkill).toContain('/workspace/generated_files/');
    expect(platformSkill).toContain('app/opsiforce.env.json');
    expect(platformSkill).toContain('/workspace/data/database.db');
    expect(platformSkill).toContain('/workspace/data/external-services.db');
    expect(platformSkill).toContain('websearch');
  });

  it('makes a first-time setup atomic and runs a root-refusing service as its own user', () => {
    expect(platformSkill).toMatch(/rename it into place once setup succeeds/);
    expect(platformSkill).toMatch(/refuses to run as root.*`startup\.sh` creates it idempotently/s);
  });

  it('owns the observability schemas and queries that left the sqlite skill', () => {
    const sqliteSkill = readFileSync(join(agentConfig, 'skills', 'sqlite', 'SKILL.md'), 'utf8');

    for (const table of ['app_requests', 'process_logs', 'process_events']) {
      expect(platformSkill).toContain(table);
      expect(sqliteSkill).not.toContain(table);
    }
  });
});

describe('the entrypoint', () => {
  it('waits for an executable startup.sh instead of crash-looping without one', () => {
    expect(entrypoint).toContain('while [ ! -x /workspace/app/startup.sh ]');
    expect(entrypoint).toContain('exec /workspace/app/startup.sh');
  });
});

describe('the app port', () => {
  it('comes from the registry entry', () => {
    const [slug, entry] = Object.entries(readMergedAgentRegistry().agents)[0];

    expect(entry.port).toBeDefined();
    expect(agentAppPort(slug)).toBe(entry.port);
  });

  it('falls back for an agent the registry does not know', () => {
    expect(agentAppPort('no-such-agent')).toBe(FALLBACK_APP_PORT);
  });

  it('is the one port the backend routes every environment through', () => {
    const declared = Object.keys(readMergedAgentRegistry().agents).map(agentAppPort);

    expect(declared.length).toBeGreaterThan(0);
    for (const port of declared) {
      expect(sharedAppPort()).toBe(port);
    }
  });

  it('is the container port and the APP_PORT the pod exports', () => {
    const spec = buildPodSpec(baseOptions({ agentName: 'app-builder' }));
    const expected = agentAppPort('app-builder');

    expect(spec.spec?.containers[0].ports?.map((port) => port.containerPort)).toContain(expected);
    expect(environmentOf(spec).get('APP_PORT')).toBe(String(expected));
  });

  it('is never absent from the pod, even for an unknown agent', () => {
    const spec = buildPodSpec(baseOptions({ agentName: 'custom' }));

    expect(environmentOf(spec).get('APP_PORT')).toBe(String(FALLBACK_APP_PORT));
  });
});

describe('the platform-api credential in the pod', () => {
  const platformApi = {
    platformApiKey: 'gw-platform',
    platformApiUrl: 'http://opsiforce-backend:3001/api/v1',
    runtimeProxyUrl: 'http://proxy-agent:3005',
  };

  it('reaches a pod that holds a platform-api key', () => {
    const withKey = environmentOf(buildPodSpec(baseOptions(platformApi)));

    expect(withKey.get('OPSIFORCE_API_KEY')).toBe('gw-platform');
    expect(withKey.get('OPSIFORCE_API_URL')).toBe('http://opsiforce-backend:3001/api/v1');
  });

  it('carries the runtime proxy origin beside the platform API base', () => {
    const withKey = environmentOf(buildPodSpec(baseOptions(platformApi)));

    expect(withKey.get('OPSIFORCE_RUNTIME_PROXY_URL')).toBe('http://proxy-agent:3005');
  });

  it('is absent from every other pod', () => {
    const ordinary = environmentOf(buildPodSpec(baseOptions()));

    expect(ordinary.has('OPSIFORCE_API_KEY')).toBe(false);
    expect(ordinary.has('OPSIFORCE_API_URL')).toBe(false);
    expect(ordinary.has('OPSIFORCE_RUNTIME_PROXY_URL')).toBe(false);
  });

  it('is absent when the key exists but no base URL is configured', () => {
    const halfConfigured = environmentOf(buildPodSpec(baseOptions({ platformApiKey: 'gw-platform' })));

    expect(halfConfigured.has('OPSIFORCE_API_KEY')).toBe(false);
  });

  it('is absent when the key and base URL exist but no runtime proxy origin does', () => {
    const halfConfigured = environmentOf(
      buildPodSpec(
        baseOptions({ platformApiKey: 'gw-platform', platformApiUrl: 'http://opsiforce-backend:3001/api/v1' })
      )
    );

    expect(halfConfigured.has('OPSIFORCE_API_KEY')).toBe(false);
    expect(halfConfigured.has('OPSIFORCE_API_URL')).toBe(false);
  });

  it('never rides on the service gateway variables', () => {
    const env = environmentOf(
      buildPodSpec(baseOptions({ ...platformApi, gatewayApiKey: 'gw-service', gatewayUrl: 'http://gw/api/gateway' }))
    );

    expect(env.get('SERVICE_GATEWAY_API_KEY')).toBe('gw-service');
    expect(env.get('OPSIFORCE_API_KEY')).toBe('gw-platform');
  });
});
