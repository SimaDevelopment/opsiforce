import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FALLBACK_APP_PORT, agentAppPort, sharedAppPort, readMergedAgentRegistry } from '../src/agent/agent-config';
import { buildPodSpec, type PodTemplateOptions } from '../src/pod/pod.template';
import { resolvePreset, toK8sResources } from '../src/pod/pod-classes';
import { packageSkillNames } from '../src/store/skill-tree';

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
    expect(named).toContain('EXTERNAL_SERVICES_HOST');
    expect(named).not.toContain('EXTERNAL_SERVICES_URL');
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
    expect(platformSkill).toContain('/workspace/data/logs/');
    expect(platformSkill).toContain('/workspace/data/external-services.db');
    expect(platformSkill).toContain('websearch');
  });

  it('carries the one External Services section every Service skill leans on', () => {
    const [, section] = /^## External Services[^\n]*\n([\s\S]*?)^## /m.exec(platformSkill) ?? [];

    expect(section).toBeDefined();
    expect(section).toContain('https://<slug>.$EXTERNAL_SERVICES_HOST');
    expect(section).toContain('/.well-known/opsiforce');
    expect(section).toContain('Authorization: Bearer $SERVICE_GATEWAY_API_KEY');
    expect(section).toMatch(/never in a URL/);
    expect(section).toContain('Opsiforce-Outcome');
    expect(section).toMatch(/never retry/i);
    expect(section).toContain("configure this Project's External Services");
    expect(section).toContain('`data`');
    expect(section).toContain('Development changes go live on Publish');
  });

  it('leaves the Operation-era calls and refusal codes behind', () => {
    for (const retired of [
      'EXTERNAL_SERVICES_URL',
      'openapi.json',
      'callService',
      '/calls',
      'operation-off',
      'out-of-bounds',
      'configuration-incomplete',
      'service-starting',
      'x-opsiforce-via',
    ]) {
      expect(platformSkill, retired).not.toContain(retired);
    }
  });

  it('makes a first-time setup atomic and runs a root-refusing service as its own user', () => {
    expect(platformSkill).toMatch(/rename it into place once setup succeeds/);
    expect(platformSkill).toMatch(/refuses to run as root.*`startup\.sh` creates it idempotently/s);
  });

  it('owns the observability schemas and queries that left the sqlite skill', () => {
    const sqliteSkill = readFileSync(join(agentConfig, 'skills', 'sqlite', 'SKILL.md'), 'utf8');

    expect(platformSkill).toContain('app_requests');
    expect(sqliteSkill).not.toContain('app_requests');
    expect(platformSkill).toContain('process-logs --events --since 2m');
    expect(sqliteSkill).not.toContain('process-logs');
  });

  it('reads process output from log files, not from tables that no longer exist', () => {
    for (const table of ['process_logs', 'process_events']) {
      expect(platformSkill).not.toContain(table);
    }
    expect(platformSkill).toContain('/workspace/data/logs/');
  });
});

describe('the inbound skills that became Service skills', () => {
  it('ship in no package, so the content sweep removes them once from every workspace that owned them', () => {
    for (const agent of Object.keys(readMergedAgentRegistry().agents)) {
      const shipped = packageSkillNames(agent);
      expect(shipped.has('incoming-email'), agent).toBe(false);
      expect(shipped.has('whatsapp'), agent).toBe(false);
    }
  });

  it('are given by no agents.json entry: an Agent gets a Service skill through the Store, a Project through its configuration', () => {
    for (const [agent, entry] of Object.entries(readMergedAgentRegistry().agents)) {
      expect(Object.keys(entry), agent).not.toContain('skills');
    }
  });
});

const OBSERVER_DIRECTORY = '/opt/opsiforce/opencode-plugins/observer';
const GPT_6_MODELS = ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-sol-fast'];
const CLAUDE_EFFORT_OPT_OUTS = ['claude-opus-5', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1'];

interface OpencodeProvider {
  settings?: Record<string, unknown>;
  models: Record<string, { settings?: Record<string, unknown>; compatibility?: Record<string, unknown> }>;
}

describe.each(['opencode.json', 'opencode.local.json'])('the opencode config %s', (file) => {
  const config = JSON.parse(readFileSync(join(agentConfig, file), 'utf8')) as {
    plugins?: string[];
    providers: Record<string, OpencodeProvider>;
  };
  const { openai, anthropic } = config.providers;

  it('sends OpenAI over HTTP, loads the observer once and switches off opencode’s own tools plugin', () => {
    expect(openai.settings?.transport).toBe('http');
    expect(config.plugins?.filter((entry) => entry === OBSERVER_DIRECTORY)).toHaveLength(1);
    expect(config.plugins).toContain('-opencode.tools');
  });

  it('opts the named models out of the terse verbosity default and of in-place effort updates', () => {
    for (const model of GPT_6_MODELS) {
      expect(openai.models[model]?.settings?.textVerbosity, model).toBe('medium');
      expect(openai.models[model]?.compatibility?.supportsEffortUpdates, model).toBe(false);
    }
    for (const model of CLAUDE_EFFORT_OPT_OUTS) {
      expect(anthropic.models[model]?.compatibility?.supportsEffortUpdates, model).toBe(false);
    }
  });

  it('sets no Anthropic reasoningEffort, a setting the Anthropic protocol never reads', () => {
    expect(JSON.stringify(anthropic)).not.toContain('reasoningEffort');
  });
});

describe('the opencode plugins', () => {
  it('build against the plugin API of the opencode the agent image installs', () => {
    const dockerfile = readFileSync(join(process.cwd(), '..', 'docker', 'Dockerfile.agent'), 'utf8');
    const { devDependencies } = JSON.parse(
      readFileSync(join(process.cwd(), '..', 'opencode-plugins', 'package.json'), 'utf8')
    ) as { devDependencies: Record<string, string> };
    const [, cli] = /@opencode\/cli@(\S+)/.exec(dockerfile) ?? [];
    const [, plugin] = /@opencode\/plugin@(\S+)/.exec(dockerfile) ?? [];

    expect(cli).toBeDefined();
    expect(plugin).toBe(cli);
    expect(devDependencies['@opencode/plugin']).toBe(cli);
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

describe('the pod credentials for the platform', () => {
  const service = { gatewayApiKey: 'gw-service', gatewayUrl: 'http://gw/api/gateway' };

  it('gives every pod the runtime proxy origin beside its one service key', () => {
    const env = environmentOf(buildPodSpec(baseOptions({ ...service, runtimeProxyUrl: 'http://proxy-agent:3005' })));

    expect(env.get('SERVICE_GATEWAY_API_KEY')).toBe('gw-service');
    expect(env.get('OPSIFORCE_RUNTIME_PROXY_URL')).toBe('http://proxy-agent:3005');
  });

  it('leaves the runtime proxy origin out when none is configured', () => {
    const env = environmentOf(buildPodSpec(baseOptions(service)));

    expect(env.has('OPSIFORCE_RUNTIME_PROXY_URL')).toBe(false);
  });

  it('never hands a pod a second key or the platform API base', () => {
    const env = environmentOf(buildPodSpec(baseOptions({ ...service, runtimeProxyUrl: 'http://proxy-agent:3005' })));

    expect(env.has('OPSIFORCE_API_KEY')).toBe(false);
    expect(env.has('OPSIFORCE_API_URL')).toBe(false);
  });
});
