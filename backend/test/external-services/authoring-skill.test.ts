import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  allowAll,
  defineService,
  refusalStatuses,
  route,
  type FormHandlerContext,
  type RouteContext,
  type WebhookContext,
} from '@opsiforce/external-service-sdk';
import {
  fieldTypes,
  generatedAlphabets,
  configurationHookNames,
  serviceTestReportPath,
  testReportResults,
  testReportSources,
  textFormats,
} from '@opsiforce/external-service-sdk/platform';
import {
  builtInCounterNames,
  callerIdentityHeader,
  createMemoryServiceState,
  createServicePipeline,
  mintCallerIdentity,
  withAtomicUpdate,
} from '@opsiforce/external-service-sdk/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { validateSkillTree } from '../../src/store/gate';
import { packageSkillNames, readSkillTree } from '../../src/store/skill-tree';

const opsiforceRoot = join(process.cwd(), '..');
const agentConfig = join(opsiforceRoot, 'agent-config');
const builderPackage = join(agentConfig, 'agents', 'external-service-builder');
const skillRoot = join(builderPackage, 'skills', 'external-service-authoring');
const template = join(builderPackage, 'template', 'app');
const sdkSource = join(opsiforceRoot, 'external-service-sdk', 'src');
const dockerfile = readFileSync(join(opsiforceRoot, 'docker', 'Dockerfile.agent'), 'utf8');
const laneController = readFileSync(
  join(process.cwd(), 'src', 'external-services', 'custom', 'builder-lane.controller.ts'),
  'utf8'
);

function read(path: string): string {
  return readFileSync(join(skillRoot, path), 'utf8');
}

const skill = read('SKILL.md');
const references = Object.fromEntries(
  readdirSync(join(skillRoot, 'references')).map((file) => [file, read(join('references', file))])
);
const prompt = readFileSync(join(builderPackage, 'agent.md'), 'utf8');
const everything = [skill, ...Object.values(references)].join('\n');
const vendors =
  /\b(GitHub|Trello|Jira|Atlassian|Slack|Mailgun|WhatsApp|Whapi|Meta|Google|Microsoft|Stripe|Notion|Linear|GH_[A-Z_]+)\b/;
const vendorShapes =
  /\b(gh|kubectl|glab|installed_version)\b|acme\/|\/1\/(boards|cards|members|search)|\/api\/v3\b|pull request/i;

function backticked(markdown: string): Set<string> {
  return new Set([...markdown.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]));
}

function importedNames(markdown: string, from: string): { name: string; typeOnly: boolean }[] {
  const pattern = new RegExp(`import (type )?\\{([^}]+)\\} from '${from.replaceAll('/', '\\/')}'`, 'g');
  return [...markdown.matchAll(pattern)].flatMap((match) =>
    match[2]
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '')
      .map((entry) => ({
        name: entry.replace(/^type\s+/, ''),
        typeOnly: match[1] !== undefined || entry.startsWith('type '),
      }))
  );
}

function namedMembers(markdown: string, owner: RegExp): Set<string> {
  return new Set([...markdown.matchAll(owner)].map((match) => match[1]));
}

describe('the external-service-authoring skill', () => {
  it('ships only in the External Service Builder package', () => {
    expect(packageSkillNames('external-service-builder', agentConfig)).toContain('external-service-authoring');
    expect(packageSkillNames('app-builder', agentConfig)).not.toContain('external-service-authoring');
    expect(packageSkillNames('skill-agent-builder', agentConfig)).not.toContain('external-service-authoring');
  });

  it('passes the Skill gate with no errors and no lints', () => {
    const result = validateSkillTree(readSkillTree(skillRoot), { expectedName: 'external-service-authoring' });

    expect({ errors: result.errors, lints: result.lints }).toEqual({ errors: [], lints: [] });
  });

  it('points at the SDK copy where the agent image lays it, and at no reference service', () => {
    expect(skill).toContain('/opt/opsiforce/external-service-sdk/latest/');
    expect(dockerfile).toContain('/opt/opsiforce/external-service-sdk/');
    expect(everything).not.toContain('/opt/agents/external-service-builder/reference/');
  });

  it('is what the prompt loads, and neither teaches SDK 1 or the old Gate', () => {
    expect(prompt).toContain('`external-service-authoring`');
    for (const retired of [
      /\bOperations?\b/,
      'defineHandlers',
      'handlers.ts',
      'ServiceError',
      'ctx.bounds',
      'boundTo',
      'EXTERNAL_SERVICES_URL',
      'probe/calls',
      'openapi.json',
      '/_service',
      'x-opsiforce-gate',
      'generate --from-openapi',
      'out-of-bounds',
    ]) {
      const found = (text: string) => (typeof retired === 'string' ? text.includes(retired) : retired.test(text));
      expect({ retired: String(retired), inSkill: found(everything), inPrompt: found(prompt) }).toEqual({
        retired: String(retired),
        inSkill: false,
        inPrompt: false,
      });
    }
  });

  it('holds the four rules in the prompt', () => {
    for (const rule of [
      'Follow the upstream',
      'Nothing passes without a setting',
      'Refuse so the user knows what to do',
      'A human publishes; report what is true',
    ]) {
      expect(prompt).toContain(rule);
    }
  });
});

describe('the skill against SDK 2 as built', () => {
  const contexts: { route?: RouteContext; form?: FormHandlerContext; webhook?: WebhookContext } = {};
  let serviceMembers: string[] = [];

  beforeAll(async () => {
    const service = defineService({
      manifest: { sdk: 2, displayName: 'Probe', description: 'Probe', inbound: true },
      routes: [
        route('GET /probe', {
          summary: 'Probe',
          allowedBy: [],
          check: allowAll,
          handle: (_request, ctx) => {
            contexts.route = ctx;
            return Response.json({});
          },
        }),
      ],
      options: {
        probe: (_draft, ctx) => {
          contexts.form = ctx;
          return [];
        },
      },
      webhook: (_request, ctx) => {
        contexts.webhook = ctx;
        return new Response(null, { status: 204 });
      },
    });
    const gatewayKey = 'gw-authoring-skill-probe';
    const pipeline = createServicePipeline(service, {
      gatewayKey,
      configurations: {
        forCaller: async () => ({
          serviceConfiguration: {},
          projectConfiguration: {},
          missing: { serviceForm: [], projectForm: [] },
        }),
        service: async () => ({}),
        projectConfigurations: async () => [],
      },
      upstreams: {
        runsCredentials: false,
        send: () => Promise.reject(new Error('no upstream in this probe')),
      },
      state: withAtomicUpdate(createMemoryServiceState()),
    });
    const call = async (kind: 'call' | 'platform', method: string, target: string, body: string | null) => {
      const identity =
        kind === 'call'
          ? { kind, tenantId: 't', projectId: 'p', projectEnvironmentId: 'pe', environment: 'development' }
          : { kind, tenantId: 't' };
      const answer = await pipeline.answer({
        method,
        target,
        headers: new Headers({ host: 'probe.test', [callerIdentityHeader]: mintCallerIdentity(identity, gatewayKey) }),
        body: body === null ? null : new Response(body).body,
      });
      await answer.arrayBuffer();
    };
    await call('call', 'GET', '/probe', null);
    await call(
      'platform',
      'POST',
      '/.well-known/opsiforce/options/probe',
      JSON.stringify({ form: 'serviceForm', values: {} })
    );
    await call('platform', 'POST', '/.well-known/opsiforce/webhook', '{}');
    serviceMembers = Object.keys(pipeline.service);
  });

  it('names only ctx members the route, form and webhook contexts have', () => {
    const real = new Set(
      [contexts.route, contexts.form, contexts.webhook].flatMap((ctx) => (ctx ? Object.keys(ctx) : []))
    );
    const named = namedMembers(everything, /\bctx\.([a-zA-Z]+)/g);

    expect(real.size).toBeGreaterThan(0);
    expect([...named].filter((member) => !real.has(member))).toEqual([]);
  });

  it('names only service members the service handle has', () => {
    const named = namedMembers(
      everything.replaceAll(/service\.(json|ts|types\.ts|test\.ts)\b/g, '').replaceAll('.service.serviceHost', ''),
      /(?<![\w-])service\.([a-zA-Z]+)/g
    );

    expect([...named].filter((member) => !serviceMembers.includes(member))).toEqual([]);
  });

  it('names only state methods the store has', () => {
    const named = namedMembers(everything, /state\.([a-zA-Z]+)\(/g);
    const state = contexts.route?.state as unknown as Record<string, unknown>;

    expect([...named].filter((method) => typeof state?.[method] !== 'function')).toEqual([]);
  });

  it('imports only names the SDK entry points export', () => {
    const root = readFileSync(join(sdkSource, 'index.ts'), 'utf8');
    const testing = readFileSync(join(sdkSource, 'testing.ts'), 'utf8');
    const missing = [
      ...importedNames(everything, '@opsiforce/external-service-sdk').filter(
        ({ name }) => !new RegExp(`\\b${name}\\b`).test(root)
      ),
      ...importedNames(everything, '@opsiforce/external-service-sdk/testing').filter(
        ({ name }) => !new RegExp(`\\b${name}\\b`).test(testing)
      ),
    ];

    expect(importedNames(everything, '@opsiforce/external-service-sdk').length).toBeGreaterThan(3);
    expect(missing).toEqual([]);
  });

  it('teaches every refusal outcome, the Opsiforce headers and the built-in counters', () => {
    const routes = references['routes.md'];

    expect(Object.keys(refusalStatuses).filter((outcome) => !routes.includes(`*${outcome}*`))).toEqual([]);
    expect(routes).toContain('Opsiforce-Outcome');
    expect(routes).toContain('Opsiforce-Setting');
    expect(builtInCounterNames.filter((name) => !routes.includes(`\`${name}\``))).toEqual([]);
  });

  it('teaches the save hooks by name', () => {
    expect(configurationHookNames.filter((name) => !references['handlers.md'].includes(name))).toEqual([]);
  });

  it('teaches every field type, text format and generated alphabet of the field catalog', () => {
    const named = backticked(references['manifest.md']);

    expect(fieldTypes.filter((type) => !named.has(type))).toEqual([]);
    expect(textFormats.filter((format) => !named.has(format))).toEqual([]);
    expect(generatedAlphabets.filter((alphabet) => !named.has(alphabet))).toEqual([]);
  });

  it('teaches every CLI command the service folder runs', () => {
    for (const command of ['types', 'check', 'dev', 'serve', 'report']) {
      expect(everything).toContain(`external-service-cli ${command}`);
    }
  });

  it('teaches the test report line shape the Publish review reads', () => {
    const testing = references['testing.md'];
    const named = backticked(testing);

    expect(testing).toContain(serviceTestReportPath);
    expect(testReportResults.filter((result) => !named.has(result))).toEqual([]);
    expect(testReportSources.filter((source) => !named.has(source))).toEqual([]);
  });
});

describe('the builder lane the skill drives', () => {
  const laneRoutes = [
    ...laneController
      .slice(0, laneController.indexOf('GATE_BUILDER_LANE_PATH)'))
      .matchAll(/@(Get|Post|Put)\((?:'([^']*)')?\)/g),
  ].map((match) => ({ method: match[1].toUpperCase(), path: match[2] ?? '' }));

  const shapes = laneRoutes.map((entry) => ({
    path: entry.path,
    shape: new RegExp(`^${entry.path.replaceAll(/:[a-zA-Z]+/g, '[^/?"\\s]+')}$`),
  }));
  const named = [...everything.matchAll(/(?:\$LANE|_builder)\/([a-zA-Z0-9/_-]+)/g)].map((match) => match[1]);

  it('names only routes the lane serves at $SERVICE_GATEWAY_URL/_builder', () => {
    expect(laneRoutes.length).toBeGreaterThan(5);
    expect(named.filter((path) => !shapes.some(({ shape }) => shape.test(path)))).toEqual([]);
    expect(everything).toContain('$SERVICE_GATEWAY_URL/_builder');
  });

  it('teaches every route the lane serves', () => {
    const untaught = shapes.filter(({ path, shape }) => path !== '' && !named.some((example) => shape.test(example)));

    expect(untaught.map(({ path }) => path)).toEqual([]);
  });
});

describe('the template the skill describes', () => {
  it('names every file the template lays in the skill’s folder table', () => {
    for (const file of [
      'service.json',
      'service.types.ts',
      'service.ts',
      'src/upstreams.ts',
      'src/groups/<group>.ts',
      'test/groups/<group>.test.ts',
      'test/service.test.ts',
      'SKILL.md',
      'README.md',
    ]) {
      expect(skill).toContain(`\`${file}\``);
    }
    for (const file of ['service.ts', 'src/upstreams.ts', 'test/service.test.ts', 'SKILL.md', 'README.md']) {
      expect(readFileSync(join(template, file), 'utf8').length).toBeGreaterThan(0);
    }
  });

  it('gives the Service skill skeleton the sections the service-skill reference requires', () => {
    const skeleton = readFileSync(join(template, 'SKILL.md'), 'utf8');

    for (const heading of [
      'Setting up a client',
      'The upstream API',
      'Differences from the upstream',
      'Conventions',
      'Events',
      'Invented endpoints',
      'Where the upstream keeps its own record',
    ]) {
      expect(skeleton).toContain(`## ${heading}`);
    }
  });
});

describe('the patterns reference', () => {
  const patterns = references['patterns.md'];

  it('holds the generic snippets the spec names', () => {
    for (const piece of [
      'Credentials',
      'minted-token cache',
      'lookup',
      'through',
      'body dispatch',
      'text/plain',
      'access-level helper',
      'quota',
      'webhook that delivers',
    ]) {
      expect(patterns).toContain(piece);
    }
  });

  it('names no vendor', () => {
    expect(patterns.match(vendors)?.[0] ?? null).toBeNull();
  });
});

describe('every instruction the builder reads', () => {
  it('names no vendor', () => {
    const instructions = {
      'agent.md': prompt,
      'SKILL.md': skill,
      ...Object.fromEntries(Object.entries(references).map(([file, text]) => [`references/${file}`, text])),
      'template SKILL.md': readFileSync(join(template, 'SKILL.md'), 'utf8'),
      'template README.md': readFileSync(join(template, 'README.md'), 'utf8'),
    };
    const named = Object.entries(instructions)
      .map(([file, text]) => ({ file, vendor: text.match(vendors)?.[0] }))
      .filter(({ vendor }) => vendor !== undefined);

    expect(named).toEqual([]);
  });

  it("keeps examples free of one vendor's CLI, ids and paths", () => {
    const instructions = {
      'agent.md': prompt,
      'SKILL.md': skill,
      ...Object.fromEntries(Object.entries(references).map(([file, text]) => [`references/${file}`, text])),
      'template SKILL.md': readFileSync(join(template, 'SKILL.md'), 'utf8'),
      'template README.md': readFileSync(join(template, 'README.md'), 'utf8'),
      'platform SKILL.md': readFileSync(join(agentConfig, 'skills', 'platform', 'SKILL.md'), 'utf8'),
    };
    const shaped = Object.entries(instructions)
      .map(([file, text]) => ({ file, shape: text.match(vendorShapes)?.[0] }))
      .filter(({ shape }) => shape !== undefined);

    expect(shaped).toEqual([]);
  });
});
