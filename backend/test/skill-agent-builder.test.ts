import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readMergedAgentRegistry } from '../src/agent/agent-config';
import { BUILDER_AGENT_SLUG } from '../src/agent/agent-visibility';
import { unpackSkill, validateSkillTree, type GateFinding } from '../src/store/gate';
import { packageSkillNames, readSkillTree } from '../src/store/skill-tree';

const agentConfig = join(process.cwd(), '..', 'agent-config');
const packageRoot = join(agentConfig, 'agents', BUILDER_AGENT_SLUG);
const templateScripts = join(packageRoot, 'template', 'scripts');
const generator = join(agentConfig, 'scripts', 'generate-validate-skill.mjs');
const validator = join(templateScripts, 'validate-skill.mjs');
const packer = join(templateScripts, 'pack-skill.mjs');
const gateDir = join(process.cwd(), 'src', 'store', 'gate');

const persona = readFileSync(join(packageRoot, 'agent.md'), 'utf8');
const platformSkill = readFileSync(join(agentConfig, 'skills', 'platform', 'SKILL.md'), 'utf8');
const skillAuthoring = readFileSync(join(packageRoot, 'skills', 'skill-authoring', 'SKILL.md'), 'utf8');
const agentAuthoring = readFileSync(join(packageRoot, 'skills', 'agent-authoring', 'SKILL.md'), 'utf8');
const testLoop = readFileSync(join(packageRoot, 'skills', 'agent-authoring', 'references', 'test-loop.md'), 'utf8');
const stackSkill = readFileSync(join(packageRoot, 'skills', 'agent-authoring', 'references', 'stack-skill.md'), 'utf8');
const webAppSkill = readFileSync(join(agentConfig, 'skills', 'web-app', 'SKILL.md'), 'utf8');
const gateRules = readFileSync(
  join(packageRoot, 'skills', 'skill-authoring', 'references', 'gate-rules.md'),
  'utf8'
);

const temporaryDirectories: string[] = [];

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), 'builder-package-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function node(script: string, args: string[]): { stdout: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', script, ...args], {
      encoding: 'utf8',
    });
    return { stdout, status: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; status?: number };
    if (failure.status === undefined) throw error;
    return { stdout: failure.stdout ?? failure.stderr ?? '', status: failure.status };
  }
}

function validateOffline(directory: string, name?: string): { valid: boolean; errors: GateFinding[]; lints: GateFinding[] } {
  const { stdout } = node(validator, [directory, '--json', ...(name === undefined ? [] : ['--name', name])]);
  return JSON.parse(stdout);
}

function writeTree(files: Record<string, string>): string {
  const directory = scratch();
  for (const [path, contents] of Object.entries(files)) {
    const absolute = join(directory, path);
    mkdirSync(join(absolute, '..'), { recursive: true });
    writeFileSync(absolute, contents);
  }
  return directory;
}

const goodSkill = {
  'SKILL.md': [
    '---',
    'name: release-notes',
    'description: Use this skill when the user asks for release notes, a changelog entry or a summary of merged pull requests, including how to group changes and what tone to use.',
    '---',
    '',
    '# Release notes',
    '',
    '`references/tone.md` has the house voice.',
    '',
  ].join('\n'),
  'references/tone.md': '# Tone\n\nPlain, short, active.\n',
};

describe('the Skill & Agent Builder registry entry', () => {
  const entry = readMergedAgentRegistry().agents[BUILDER_AGENT_SLUG];

  it('is a second public entry with the pinned literals', () => {
    expect(entry).toBeDefined();
    expect(entry.name).toBe('Skill & Agent Builder');
    expect(entry.description).toBeTruthy();
    expect(entry.port).toBe(3000);
    // Not a literal: CLAUDE.md requires this to rise with every behaviour change to the package.
    expect(entry.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(entry.poolSize).toBe(0);
    expect(entry.platformApi).toBe(true);
    expect(entry.default).not.toBe(true);
  });

  it('runs the same model pair as the default agent, so nobody has to choose one', () => {
    const app = readMergedAgentRegistry().agents['app-builder'];

    expect(entry.model).toBe(app.model);
    expect(entry.variant).toBe(app.variant);
  });

  it('ships in the public registry the standalone mirror carries, not behind the private seam', () => {
    const publicRegistry = JSON.parse(readFileSync(join(agentConfig, 'agents.json'), 'utf8'));
    const privateFragment = JSON.parse(readFileSync(join(agentConfig, 'private', 'agents.json'), 'utf8'));

    expect(Object.keys(publicRegistry.agents)).toContain(BUILDER_AGENT_SLUG);
    expect(Object.keys(privateFragment.agents)).not.toContain(BUILDER_AGENT_SLUG);
  });

  it('rides an image version past the one that predates the package', () => {
    const rank = (major: number, minor: number, patch: number): number => major * 1e6 + minor * 1e3 + patch;
    const { version } = JSON.parse(readFileSync(join(agentConfig, 'agent-image-version.json'), 'utf8'));
    const [major, minor, patch] = String(version).split('.').map(Number);

    expect([major, minor, patch].every(Number.isInteger)).toBe(true);
    expect(rank(major, minor, patch)).toBeGreaterThan(rank(0, 12, 0));
  });
});

describe('the package', () => {
  const composed = packageSkillNames(BUILDER_AGENT_SLUG, agentConfig);

  it('composes the platform skill and the two authoring skills', () => {
    expect(composed).toContain('platform');
    expect(composed).toContain('skill-authoring');
    expect(composed).toContain('agent-authoring');
  });

  it('carries the authoring skills as its own overrides, not in the shared pool every agent gets', () => {
    const shared = packageSkillNames('app-builder', agentConfig);

    expect(shared).not.toContain('skill-authoring');
    expect(shared).not.toContain('agent-authoring');
  });

  it('ships a template with no app, so the pod idles instead of serving', () => {
    const template = readSkillTree(join(packageRoot, 'template')).map((file) => file.path);

    expect(template).toContain('scratch/README.md');
    expect(template).toContain('scripts/validate-skill.mjs');
    expect(template).toContain('scripts/pack-skill.mjs');
    expect(template).toContain('scripts/api.sh');
    expect(template.filter((path) => path.startsWith('app/'))).toEqual([]);
    expect(template).not.toContain('startup.sh');
  });

  it('both skills pass the gate they teach', () => {
    for (const name of ['skill-authoring', 'agent-authoring']) {
      const result = validateSkillTree(readSkillTree(join(packageRoot, 'skills', name)), { expectedName: name });

      expect({ name, errors: result.errors, lints: result.lints }).toEqual({ name, errors: [], lints: [] });
    }
  });
});

describe('the offline validator', () => {
  it('is a byte-for-byte copy of what the generator produces from the gate today', () => {
    const out = join(scratch(), 'validate-skill.mjs');
    node(generator, ['--out', out]);

    expect(readFileSync(out)).toEqual(readFileSync(validator));
  });

  it('records the hash of every gate source it was cut from', () => {
    const header = readFileSync(validator, 'utf8').split('*/')[0];
    const recorded = [...header.matchAll(/gate\/(\S+\.ts)\s+([0-9a-f]{64})/g)];

    expect(recorded.length).toBeGreaterThan(0);
    for (const [, name, hash] of recorded) {
      const live = createHash('sha256').update(readFileSync(join(gateDir, name))).digest('hex');

      expect({ name, hash }).toEqual({ name, hash: live });
    }
  });

  it('answers exactly what the backend gate answers, tree for tree', () => {
    const trees: Record<string, string>[] = [
      goodSkill,
      { 'references/tone.md': '# Tone\n' },
      { 'SKILL.md': 'no frontmatter here\n' },
      { 'SKILL.md': '---\nname: Bad_Name\nwhat: no\n---\n\nbody\n' },
      { 'SKILL.md': '---\nname: short\ndescription: Too short.\n---\n\n`references/missing.md`\n' },
      {
        'SKILL.md': '---\nname: leaky\ndescription: Use this when the tree carries a credential it must not, twenty words long so the description lint stays quiet.\nallowed-tools: bash\n---\n\nAKIAIOSFODNN7EXAMPLE\n',
      },
    ];

    for (const files of trees) {
      const directory = writeTree(files);
      const expected = validateSkillTree(readSkillTree(directory), { expectedName: 'release-notes' });
      const actual = validateOffline(directory, 'release-notes');

      expect(actual.errors).toEqual(expected.errors);
      expect(actual.lints).toEqual(expected.lints);
      expect(actual.valid).toBe(expected.errors.length === 0);
    }
  });

  it('exits non-zero on a tree the API would refuse, and zero on one it would take', () => {
    expect(node(validator, [writeTree(goodSkill), '--name', 'release-notes']).status).toBe(0);
    expect(node(validator, [writeTree({ 'SKILL.md': 'nope\n' }), '--name', 'release-notes']).status).toBe(1);
  });

  it('reports every rule it can emit in the skill that documents them', () => {
    const gate = readFileSync(join(gateDir, 'validate.ts'), 'utf8');
    const rules = [...gate.matchAll(/finding\(\s*'([a-z_]+)'/g)].map(([, rule]) => rule);

    expect(rules.length).toBeGreaterThan(15);
    for (const rule of new Set(rules)) {
      expect(gateRules, `gate-rules.md does not document \`${rule}\``).toContain(rule);
    }
  });
});

describe('the packer', () => {
  it('prints the files array the API accepts, text inline and binaries base64', async () => {
    const directory = writeTree({ ...goodSkill, 'assets/logo.png': '' });
    writeFileSync(join(directory, 'assets/logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x00, 0x01]));

    const { files } = JSON.parse(node(packer, ['--json', directory]).stdout);

    expect(files.map((file: { path: string }) => file.path)).toEqual([
      'SKILL.md',
      'assets/logo.png',
      'references/tone.md',
    ]);
    expect(files[0].content).toContain('name: release-notes');
    expect(files[0].isBinary).toBeUndefined();
    expect(files[1].isBinary).toBe(true);
    expect(Buffer.from(files[1].content, 'base64')).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x00, 0x01]));
  });

  it('writes a .skill archive the platform can unpack, executable bits intact', async () => {
    const directory = writeTree({ ...goodSkill, 'scripts/collect.sh': '#!/bin/sh\necho hi\n' });
    execFileSync('chmod', ['+x', join(directory, 'scripts/collect.sh')]);
    const out = scratch();

    node(packer, ['--skill', directory, out]);
    const unpacked = await unpackSkill(readFileSync(join(out, `${directory.split('/').pop()}.skill`)));

    expect(unpacked.map((file) => file.path).toSorted()).toEqual([
      'SKILL.md',
      'references/tone.md',
      'scripts/collect.sh',
    ]);
    expect(unpacked.find((file) => file.path === 'scripts/collect.sh')?.executable).toBe(true);
    expect(unpacked.find((file) => file.path === 'SKILL.md')?.content.toString('utf8')).toBe(goodSkill['SKILL.md']);
  });

  it('packs the same tree to the same bytes twice', () => {
    const directory = writeTree(goodSkill);
    const first = scratch();
    const second = scratch();

    node(packer, ['--skill', directory, first]);
    node(packer, ['--skill', directory, second]);
    const name = `${directory.split('/').pop()}.skill`;

    expect(readFileSync(join(first, name))).toEqual(readFileSync(join(second, name)));
  });
});

describe('the persona', () => {
  it('sends the model to the platform skill first and to the authoring skills for the job', () => {
    expect(persona).toContain('`platform`');
    expect(persona).toContain('`skill-authoring`');
    expect(persona).toContain('`agent-authoring`');
  });

  it('never restates a platform fact', () => {
    const platformFacts = [
      '$APP_PORT',
      'APP_PUBLIC_URL',
      'APP_LLM_BASE_URL',
      'SERVICE_GATEWAY_URL',
      'opsiforce.env.json',
      '/workspace/user_uploaded_files/',
      '/workspace/generated_files/',
      '/workspace/data/database.db',
    ];

    for (const fact of platformFacts) {
      expect(platformSkill, `${fact} should be a platform fact`).toContain(fact);
      expect(persona, `agent.md restates the platform fact ${fact}`).not.toContain(fact);
    }
  });

  it('reads the one subject its chat authors from the API, not from the workspace (ADR-0071)', () => {
    expect(persona).toContain('builderSubject');
    expect(persona).not.toContain('builder-subject.json');
    expect(persona).toMatch(/[Dd]o not announce\s+the reads/);
    expect(persona).toMatch(/Never `POST \/agents` for it/);
  });

  it('decides and does rather than asking for permission', () => {
    expect(persona).toMatch(/Decide, do, report/);
    expect(persona).toMatch(/nothing to ask permission for/);
    expect(persona).toMatch(/one\*\* question only when/);
  });

  it('says what the chat cannot do, and where those acts live instead', () => {
    for (const refusal of ['public', 'disable', 'delete', 'Store']) {
      expect(persona.toLowerCase()).toContain(refusal.toLowerCase());
    }
  });

  it('tells the model this project has no App to build', () => {
    expect(persona).toContain('startup.sh');
    expect(persona).toMatch(/no App|no `app\/`/);
  });
});

describe('the skill-authoring skill', () => {
  it('names the built-in catalogue call and all three offers', () => {
    expect(skillAuthoring).toContain('/skills?filter=built_in');
    for (const offer of ['Reuse', 'Extend', 'Fresh']) expect(skillAuthoring).toContain(offer);
    expect(skillAuthoring).toContain('/skills/$ID/versions');
  });

  it('splits ERRORS from LINTS and says which one blocks', () => {
    expect(skillAuthoring).toMatch(/\*\*ERRORS\*\* — the write is refused/);
    expect(skillAuthoring).toMatch(/\*\*LINTS\*\* — advice that never blocks/);
  });

  it('teaches the create, read-back, report loop', () => {
    expect(skillAuthoring).toContain('POST /skills');
    expect(skillAuthoring).toContain('/versions/$N/files');
    expect(skillAuthoring).toMatch(/read back/i);
  });

  it('points only at reference files that exist', () => {
    const tree = new Set(readSkillTree(join(packageRoot, 'skills', 'skill-authoring')).map((file) => file.path));

    for (const [, target] of skillAuthoring.matchAll(/`(references\/[\w.-]+)`/g)) expect(tree).toContain(target);
  });
});

describe('the agent-authoring skill', () => {
  it("carries ADR-0061's two rules", () => {
    expect(agentAuthoring).toMatch(/[Nn]ever restate anything the `platform` skill covers/);
    expect(agentAuthoring).toContain('Load the `platform` skill before serving anything');
  });

  it('writes the prompt guidance the ADR pins: body only, the model pair, which skills to add', () => {
    expect(agentAuthoring).toMatch(/replaces.*default system prompt/s);
    expect(agentAuthoring).toContain('/opt/opencode/models.json');
    expect(agentAuthoring).toMatch(/starts with `platform` and nothing else/);
  });

  it("carries ADR-0063's test contract", () => {
    expect(agentAuthoring).toMatch(/without being asked/);
    expect(agentAuthoring).toMatch(/Announce first, with the spend/);
    expect(agentAuthoring).toMatch(/machine-checkable/);
    expect(agentAuthoring).toMatch(/judgement/);
    expect(agentAuthoring).toMatch(/never re-test an unchanged/);
    expect(agentAuthoring).toContain('$APP_PORT');
    expect(agentAuthoring).toContain('startup.sh');
    expect(agentAuthoring).toContain('app.meta.json');
    expect(agentAuthoring).toMatch(/observability database/);
  });

  it('gives every building Agent a template to lay first and an Architecture in its body (ADR-0068)', () => {
    expect(agentAuthoring).toMatch(/Every Agent that builds starts from a template/);
    expect(agentAuthoring).toMatch(/never on an empty `app\/`/);
    expect(agentAuthoring).toContain('Load the `web-app` skill before touching the app');
    expect(agentAuthoring).toMatch(/The architecture lives in the body/);
    expect(agentAuthoring).toMatch(/scaffold Skill/);
    expect(agentAuthoring).toMatch(/Runtime dependencies are ensured by `startup.sh`, never by hand/);
    expect(agentAuthoring).toMatch(/Restart the child's pod/);
    expect(webAppSkill).toMatch(/What the starter fixes and what you change/);
    expect(webAppSkill).toContain("ls -A | grep -vxE 'data|opsiforce");
    expect(webAppSkill).not.toMatch(/\[ -e \/workspace\/app\/startup\.sh \] \|\| cp/);
  });

  it('has authored Skills frame the work and never ship an implementation to copy', () => {
    expect(agentAuthoring).toMatch(/Skills frame the work; the child writes it/);
    for (const section of ['Structure', 'Stack and libraries', 'Contracts', 'Style guide', 'Runtime', 'Anti-patterns', 'Definition of done']) {
      expect(stackSkill).toContain(`**${section}**`);
    }
    expect(stackSkill).toMatch(/What it never holds — an implementation/);
    expect(stackSkill).toMatch(/How often the checks run/);
    expect(stackSkill).toMatch(/No version pins/);
    expect(stackSkill).toContain("grep -vxE 'data|opsiforce");
    for (const text of [agentAuthoring, stackSkill, testLoop]) {
      expect(text).not.toMatch(/cp -a \/workspace\/\.opencode\/skills/);
      expect(text).not.toMatch(/md5sum/);
    }
    expect(skillAuthoring).toMatch(/never an implementation for the agent to copy/);
  });

  it('keeps the shared guidance free of any one service', () => {
    for (const [name, text] of Object.entries({ platformSkill, webAppSkill, agentAuthoring, stackSkill, testLoop, persona })) {
      expect(text, `${name} names a specific service`).not.toMatch(/postgres|mysql|redis|mongo/i);
    }
  });

  it('shares the durable-workspace rule through the platform skill, not its own words', () => {
    expect(platformSkill).toMatch(/The pod is disposable, the workspace is durable/);
    expect(platformSkill).toContain('startup.sh');
    expect(platformSkill).toMatch(/idempotently/);
    expect(platformSkill).toMatch(/runs under `guard`, in the foreground/);
    expect(platformSkill).toMatch(/What Publish carries/);
    expect(platformSkill).toMatch(/Node projects use Yarn/);
    expect(platformSkill).toMatch(/Never npm, pnpm or bun for a project/);
    expect(platformSkill).toMatch(/take its latest stable release/);
    expect(platformSkill).toMatch(/never reinstall or re-enable it from `startup.sh`/);
    expect(platformSkill).toMatch(/restarts it whenever it exits, crashed or not/);
    expect(platformSkill).toMatch(/never by a process number read from a file/);
    expect(platformSkill).toMatch(/Survive a dependency restarting/);
    expect(platformSkill).toMatch(/Never run a `guard` line or the whole script by hand/);
    expect(persona).toMatch(/disposable/);
    expect(persona).not.toMatch(/apt-get/);
  });

  it('states all four fidelity gaps', () => {
    const gaps = agentAuthoring.split('four fidelity gaps')[1] ?? '';

    expect(gaps).toMatch(/always cold/);
    expect(gaps).toMatch(/spend lands on this Organization/);
    expect(gaps).toMatch(/[Ee]xternal services/);
    expect(gaps).toMatch(/as of its creation moment/);
  });

  it('points only at reference files that exist', () => {
    const tree = new Set(readSkillTree(join(packageRoot, 'skills', 'agent-authoring')).map((file) => file.path));

    for (const [, target] of agentAuthoring.matchAll(/`(references\/[\w.-]+)`/g)) expect(tree).toContain(target);
  });
});

/** `METHOD /base/segment/:p` for every `/api/v1` route carrying `@AllowsGatewayCaller()`. */
function gatewayOpenRoutes(): Set<string> {
  const open = new Set<string>();
  for (const resource of ['projects', 'agents', 'skills', 'me']) {
    const source = readFileSync(
      join(process.cwd(), 'src', 'public-api', resource, `${resource}.controller.ts`),
      'utf8'
    );
    const [, base] = /@PublicApiController\('([^']+)'\)/.exec(source) ?? [];
    expect(base).toBe(resource);
    for (const [, method, path] of source.matchAll(
      /@(Get|Post|Put|Delete|Patch)\((?:'([^']*)')?\)\s*\n\s*@AllowsGatewayCaller\(\)/g
    )) {
      open.add(`${method.toUpperCase()} ${normalizeRoute(`/${base}/${path ?? ''}`)}`);
    }
  }
  return open;
}

/** Collapse every path parameter — `:id`, a `$shell` variable, a literal version number — and drop the query. */
function normalizeRoute(path: string): string {
  const parameter = (segment: string): boolean =>
    segment.startsWith(':') || segment.includes('$') || /^\d+$/.test(segment);
  return path
    .split('?')[0]
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => (parameter(segment) ? ':p' : segment))
    .join('/');
}

/** Every platform-API call the reference tells the Builder to make, as `METHOD path`. */
function platformCallsIn(markdown: string): string[] {
  const calls = [...markdown.matchAll(/api\.sh (?:call|status) (GET|POST|PUT|DELETE|PATCH) ["']?([^\s"']+)/g)];
  return calls.map(([, method, path]) => `${method} ${normalizeRoute(path)}`);
}

describe('the test loop reference', () => {
  it('drives only routes this pod is actually allowed to call', () => {
    const open = gatewayOpenRoutes();
    const driven = platformCallsIn(testLoop);

    expect(open.size).toBeGreaterThan(5);
    expect(driven.length).toBeGreaterThan(3);
    for (const call of new Set(driven)) {
      expect([...open], `test-loop.md drives ${call}, which is not open to a gateway caller`).toContain(call);
    }
  });

  it('is matched by the authoring references, which drive the Skill and Agent routes', () => {
    const open = gatewayOpenRoutes();
    const skillApi = readFileSync(join(packageRoot, 'skills', 'skill-authoring', 'references', 'api.md'), 'utf8');
    const agentApi = readFileSync(join(packageRoot, 'skills', 'agent-authoring', 'references', 'agent-api.md'), 'utf8');
    const driven = [...platformCallsIn(skillApi), ...platformCallsIn(agentApi), ...platformCallsIn(skillAuthoring)];

    expect(driven.length).toBeGreaterThan(8);
    for (const call of new Set(driven)) {
      expect([...open], `a reference drives ${call}, which is not open to a gateway caller`).toContain(call);
    }
  });

  it('creates the test Project the way the API accepts it', () => {
    expect(testLoop).toContain('"kind":"test"');
    expect(testLoop).toContain('POST /projects');
    expect(testLoop).toMatch(/environments\[0\]\.status/);
    expect(testLoop).toMatch(/wait_active\(\) \{[\s\S]*seq 1[\s\S]*"failed"[\s\S]*return 1/);
    expect(testLoop).not.toMatch(/until \[.*environments\[0\]\.status.*\]; do sleep/);
  });

  it('prompts and reads through the runtime, and shells for verification', () => {
    expect(testLoop).toContain('/api/session/$SES/prompt');
    expect(testLoop).toContain('/api/session/$SES/wait');
    expect(testLoop).toContain('/api/session/$SES/message');
    expect(testLoop).toContain('POST /api/shell');
    expect(testLoop).toContain('/restart');
    expect(testLoop).toContain('`timeout` set to `1200000`');
    expect(testLoop).toMatch(/genuine stall only/);
    expect(testLoop).toMatch(/Idle is not finished/);
    expect(testLoop).toContain('"finish":"error"');
    expect(agentAuthoring).toMatch(/A long turn is\s+not a stuck one/);
    expect(testLoop).toContain('/api/shell/$id/output');
  });

  it('names the resume rule and the supersede-on-create the backend performs', () => {
    expect(testLoop).toMatch(/scratch\/test-project\.json/);
    expect(testLoop).toMatch(/hides `kind`-stamped Projects from `GET \/projects`/);
    expect(testLoop).toMatch(/deletes this chat's previous test Project/);
  });
});
