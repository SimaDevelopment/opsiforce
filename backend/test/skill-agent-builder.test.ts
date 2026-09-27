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
const testProjectScript = readFileSync(join(packageRoot, 'template', 'scripts', 'tp.sh'), 'utf8');
const turnScript = readFileSync(join(packageRoot, 'template', 'scripts', 'turn.sh'), 'utf8');
const scratchReadme = readFileSync(join(packageRoot, 'template', 'scratch', 'README.md'), 'utf8');
const stackSkill = readFileSync(join(packageRoot, 'skills', 'agent-authoring', 'references', 'stack-skill.md'), 'utf8');
const templateReference = readFileSync(
  join(packageRoot, 'skills', 'agent-authoring', 'references', 'template.md'),
  'utf8'
);
const webAppSkill = readFileSync(join(agentConfig, 'skills', 'web-app', 'SKILL.md'), 'utf8');
const gateRules = readFileSync(join(packageRoot, 'skills', 'skill-authoring', 'references', 'gate-rules.md'), 'utf8');
const agentBrowserSkill = readFileSync(join(agentConfig, 'skills', 'agent-browser', 'SKILL.md'), 'utf8');
const bodyTemplate = readFileSync(
  join(packageRoot, 'skills', 'agent-authoring', 'references', 'body-template.md'),
  'utf8'
);
const skillApi = readFileSync(join(packageRoot, 'skills', 'skill-authoring', 'references', 'api.md'), 'utf8');

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

function validateOffline(
  directory: string,
  name?: string
): { valid: boolean; errors: GateFinding[]; lints: GateFinding[] } {
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

  it('carries only the shared skills its own work uses: platform, web-app for starter pinning, agent-browser for tests', () => {
    const shared = packageSkillNames('app-builder', agentConfig);
    const own = new Set(['skill-authoring', 'agent-authoring']);

    expect([...composed].filter((name) => !own.has(name)).toSorted()).toEqual(['agent-browser', 'platform', 'web-app']);
    expect(shared.size).toBeGreaterThan(composed.size);
    expect(persona).toContain('/skills?filter=built_in');
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
    expect(template).toContain('scripts/check-template.sh');
    expect(template).toContain('scripts/evidence.sh');
    expect(template).toContain('scripts/turn.sh');
    expect(template).toContain('scripts/template-snapshot.sh');
    expect(template).toContain('scripts/tp.sh');
    expect(template).toContain('scripts/check-expectations.mjs');
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
      const live = createHash('sha256')
        .update(readFileSync(join(gateDir, name)))
        .digest('hex');

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
        'SKILL.md':
          '---\nname: leaky\ndescription: Use this when the tree carries a credential it must not, twenty words long so the description lint stays quiet.\nallowed-tools: bash\n---\n\nAKIAIOSFODNN7EXAMPLE\n',
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
    expect(persona).toMatch(/start your first message with the answer/);
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

  it('validates a Skill tree under the name it will carry, and says which rules only the API answers', () => {
    expect(persona).toContain('node scripts/validate-skill.mjs scratch/<name> --name <name>');
    expect(gateRules).toMatch(/`name_reserved` and 409 `name-unavailable` come only from the\s+API/);
  });

  it('tries a Skill in the chat of an Agent that carries it, never from its own chat', () => {
    expect(persona).toMatch(
      /A Skill chat publishes and reads back; a Skill\s+is tried in the chat of an Agent that carries it, once that Agent re-pins the new Version/
    );
  });

  it('says what a disabled subject still allows', () => {
    expect(persona).toMatch(
      /When `disabled` is true, the Organization has taken it out of use: say so in your first sentence/
    );
    expect(persona).toMatch(/a disabled Skill takes no new Version and a disabled Agent gets\s+no Test Project/);
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

  it('scopes the warranted check by chat kind, routes uploads, and names a fallback for a taken name', () => {
    expect(skillAuthoring).toMatch(
      /In an Agent chat this decides whether to create one; in a Skill chat, name the catch-all you found/
    );
    expect(skillAuthoring).toMatch(/Files the author uploads arrive in `\/workspace\/user_uploaded_files\/`/);
    expect(skillAuthoring).not.toMatch(/POST \/skills\/validate/);
    expect(skillApi).toMatch(/choose a name that adds the Agent's slug, and tell the author the name you used/);
  });

  it('points only at reference files that exist', () => {
    const tree = new Set(readSkillTree(join(packageRoot, 'skills', 'skill-authoring')).map((file) => file.path));

    for (const [, target] of skillAuthoring.matchAll(/`(references\/[\w.-]+)`/g)) expect(tree).toContain(target);
  });
});

describe('the agent-authoring skill', () => {
  it("carries ADR-0061's two rules", () => {
    expect(agentAuthoring).toMatch(/[Nn]ever restate anything the `platform` skill covers/);
    expect(agentAuthoring).toMatch(
      /Load the `platform` skill before\s+you build, serve or deliver anything, and check your work the way it and `## Done looks like` say/
    );
    expect(agentAuthoring).not.toMatch(/no base persona/);
  });

  it('puts a rule every piece of work obeys in the body, and the rest of the know-how in a Skill', () => {
    expect(agentAuthoring).toMatch(/A rule every piece of work must obey[\s\S]*goes in the\s+body's `## Domain rules`/);
    expect(bodyTemplate).toMatch(
      /when to ask: what the Agent decides on its own, and which missing facts it asks for, in one question/
    );
  });

  it('gives changing an existing Agent one home, which says existing Projects keep what they have', () => {
    const changing = agentAuthoring.split('## Changing an existing Agent')[1] ?? '';

    expect(changing).toMatch(/read its Development profile, its pinned Skills and\s+`template\/` first/);
    expect(changing).toMatch(/existing ones keep what they have/);
    expect(changing).toContain('§When `template/`');
    expect(agentAuthoring.split('## Changing an existing Agent')[0]).not.toMatch(
      /when this chat edits an existing Agent/
    );
  });

  it("keeps an author's edit to template/ by default, and asks one question only on a contradiction or a failed check", () => {
    const section = templateReference.split('## When `template/` changed without you')[1]?.split('## ')[0] ?? '';

    expect(templateReference).toContain('sh scripts/template-snapshot.sh save');
    expect(section).toContain('sh scripts/template-snapshot.sh diff');
    expect(section).toMatch(/\*\*By default, keep it\.\*\*/);
    expect(section).toMatch(
      /\*\*The check fails on it\*\* — put the saved file back with\s+`sh scripts\/template-snapshot\.sh restore/
    );
    expect(section).toMatch(/\*\*It contradicts a requirement the brief states\*\*/);
    expect(section).toMatch(/The one question lists each such edit[\s\S]*\*keep\*, \*complete\* or\s+\*revert\*/);
  });

  it('checks the production branch only when startup.sh or what it builds changes', () => {
    expect(templateReference).toMatch(
      /When the change touches `startup.sh` or what its production branch builds, run it once more with\s+`--production`/
    );
    expect(templateReference).toContain('sh scripts/check-template.sh --production');
  });

  it('has the Template ensure whatever it needs beyond the image, App or not', () => {
    expect(templateReference).toMatch(
      /Your pod runs the child's image, so what the check finds installed, the child has too/
    );
    expect(templateReference).toMatch(
      /goes in a folder of its own, such as `examples\/`; a save leaves out\s+any folder named `data\/`/
    );
    expect(platformSkill).toMatch(
      /Work with no App follows the same rule: a script that needs something the image lacks ensures it into `\/workspace` before it runs/
    );
  });

  it('points at stack Skills the Builder can read through the API', () => {
    expect(stackSkill).toContain('GET /skills/{id}');
    expect(stackSkill).not.toContain('`ui`');
  });

  it('writes the prompt guidance the ADR pins: body only, the model pair, which skills to add', () => {
    expect(agentAuthoring).toMatch(/replaces.*default system prompt/s);
    expect(agentAuthoring).toContain('/opt/opencode/models.json');
    expect(agentAuthoring).toMatch(/starts with `platform` and nothing else/);
  });

  it("points at the test loop, which carries ADR-0063's test contract", () => {
    expect(agentAuthoring).toContain('`references/test-loop.md`');
    expect(testLoop).toMatch(/without being asked/);
    expect(testLoop).toMatch(/Announce first, with the spend/);
    expect(testLoop).toMatch(/machine-checkable/);
    expect(testLoop).toMatch(/judgement/);
    expect(testLoop).toMatch(/Never refresh for an unchanged definition/);
    expect(testLoop).toMatch(/restart the child's pod/);
    expect(agentAuthoring).toContain('$APP_PORT');
    expect(agentAuthoring).toContain('startup.sh');
    expect(agentAuthoring).toContain('app.meta.json');
    expect(agentAuthoring).toMatch(/observability database/);
  });

  it('loads agent-browser core, not the full reference, before the first interaction', () => {
    expect(agentBrowserSkill).toContain('Run `agent-browser skills get core` before your first interaction');
    expect(agentBrowserSkill).not.toMatch(/Run `agent-browser skills get core --full`/);
    expect(testLoop).toMatch(
      /These commands are all this loop needs; load `agent-browser` only for one they do not cover/
    );
  });

  it('places each thing by one rule, snapshots the starter into template/ and keeps Architecture rules in the body (ADR-0073)', () => {
    expect(agentAuthoring).toMatch(/## The Template/);
    for (const place of [
      '**Template** — files the Project owns',
      '**Skill** — know-how',
      '**Body** — who the Agent is',
    ]) {
      expect(agentAuthoring).toContain(place);
    }
    expect(agentAuthoring).toMatch(/the Agent has no Template/);
    expect(agentAuthoring).toMatch(/the author is not asked/);
    expect(agentAuthoring).toMatch(/Architecture rules live in the body/);
    expect(agentAuthoring).toMatch(/three to six rules/);
    expect(agentAuthoring).toMatch(/rules to keep, never changes to apply/);
    expect(agentAuthoring).not.toMatch(/scaffold/i);
    expect(stackSkill).not.toMatch(/scaffold|check-skeleton/i);
    expect(templateReference).toContain('cp -a /opt/agents/app-builder/template/app template/app');
    expect(templateReference).toContain('PUT "/agents/$A/template"');
    expect(templateReference).toContain('`template-refused`');
    expect(templateReference).toContain('`template-changed`');
    expect(templateReference).toContain('template: { hash }');
    expect(templateReference).toMatch(/Only when the author asks/);
    expect(persona).toMatch(/`template\/` already holds its saved Template/);
    expect(persona).toMatch(/Read what is\s+there before you write/);
    expect(webAppSkill).toMatch(/What the starter fixes and what you change/);
    expect(webAppSkill).toMatch(/## The starter is already there/);
    expect(webAppSkill).toMatch(/If it does not, stop and tell the user what you found instead of building/);
    expect(webAppSkill).not.toContain('/opt/agents/app-builder/template/app');
    expect(webAppSkill).not.toMatch(/\[ -e \/workspace\/app\/startup\.sh \] \|\| cp/);
  });

  it('has authored Skills frame the work and never ship an implementation to copy', () => {
    expect(agentAuthoring).toMatch(/Skills describe; the Template ships/);
    for (const section of [
      'Stack and libraries',
      'Contracts',
      'Style guide',
      'Runtime',
      'Anti-patterns',
      'Definition of done',
    ]) {
      expect(stackSkill).toContain(`**${section}**`);
    }
    expect(stackSkill).toMatch(/What it never holds — an implementation/);
    expect(stackSkill).toMatch(/How often the checks run/);
    expect(stackSkill).toMatch(/No version pins/);
    expect(stackSkill).toMatch(/belongs in the Template or nowhere/);
    for (const text of [agentAuthoring, stackSkill, testLoop, templateReference]) {
      expect(text).not.toMatch(/cp -a \/workspace\/\.opencode\/skills/);
      expect(text).not.toMatch(/md5sum/);
    }
    expect(skillAuthoring).toMatch(/never an implementation for the agent to copy/);
  });

  it('keeps the shared guidance free of any one service', () => {
    for (const [name, text] of Object.entries({
      platformSkill,
      webAppSkill,
      agentAuthoring,
      stackSkill,
      testLoop,
      templateReference,
      persona,
    })) {
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
    const gaps = testLoop.split('four fidelity gaps')[1] ?? '';

    expect(gaps).toMatch(/always cold/);
    expect(gaps).toMatch(/spend lands on this Organization/);
    expect(gaps).toMatch(/[Ee]xternal services/);
    expect(gaps).toMatch(/as of its last refresh/);
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
  const calls = [...markdown.matchAll(/\bapi(?:\.sh)? (?:call|status) (GET|POST|PUT|DELETE|PATCH) ["']?([^\s"')]+)/g)];
  return calls.map(([, method, path]) => `${method} ${normalizeRoute(path)}`);
}

describe('the test loop reference', () => {
  it('decides update or reset by one rule, on the word touched, and is the only place that states it', () => {
    const refresh = testLoop.split('## 5.')[1]?.split('## 6.')[0] ?? '';

    expect(refresh).toMatch(
      /\*\*touched\*\* or built on what the change alters, or the change is in the body or a Skill/
    );
    expect(refresh).toMatch(/→ \*\*reset\*\*\. Otherwise → \*\*update\*\*/);
    expect(refresh).toContain('sh scripts/tp.sh touched');
    expect(refresh).toContain('sh scripts/tp.sh update');
    expect(refresh).toContain('sh scripts/tp.sh reset');
    for (const [name, text] of Object.entries({ persona, agentAuthoring, skillAuthoring })) {
      expect(text, `${name} restates the refresh rule`).not.toMatch(/\*\*update\*\* when|\*\*reset\*\* when/);
    }
  });

  it('logs fixes as an explicit round-end step and ends the report on criteria it can check', () => {
    expect(testLoop).toMatch(/1\. \*\*Log the fixes\.\*\*/);
    expect(testLoop).toContain(
      '`- R<n> · <failed expectation> · <template|body|skill> · <the record that showed it, in words> · <what you change> · <update|reset>`'
    );
    const report = testLoop.split('## 6. Report')[1] ?? '';

    expect(report).toMatch(/\*\*The report is done when:\*\*/);
    expect(report).toContain('`node scripts/check-expectations.mjs` exits 0');
    expect(report).toMatch(
      /every expectation line is either `pass` or `fail` with one source, or `not checked` with its why/
    );
    expect(report).toMatch(/`## Fixes` has one entry per fixing round/);
    expect(report).toMatch(/every Form the child raised is listed with its answer/);
    expect(persona).toContain('`test-loop.md` §6');
  });

  it('keeps the prompts in the expectations file and resumes a round after an update', () => {
    expect(testLoop).toMatch(/\*\*`## Prompts`\*\* — one line per prompt, sent word for word every round/);
    expect(testLoop).toMatch(/After a reset, from the first prompt/);
    expect(testLoop).toMatch(/After an update the workspace still\s+holds what the prompts built/);
  });

  it('marks each verdict line with one source, and not checked as its own line shape', () => {
    const report = testLoop.split('## 6. Report')[1] ?? '';

    expect(report).toContain("- <expectation> — <pass | fail> (<mine | the child's record: …>) —");
    expect(report).toContain('- <expectation> — not checked — <why>');
    expect(report).not.toMatch(/not checked \| |<mark>/);
  });

  it('uses fixed scratch names now that a chat has one subject', () => {
    for (const [name, text] of Object.entries({ testLoop, scratchReadme })) {
      expect(text, `${name} still names a per-Agent scratch file`).not.toMatch(/<agent>\./);
    }
    expect(testLoop).toContain('scratch/expectations.md');
    expect(scratchReadme).toContain('scratch/prompt.md');
  });

  it('covers a disabled Test Project, a failed environment, secrets and outside writes', () => {
    expect(testLoop).toMatch(/\*\*`disabled:`\*\*[\s\S]*Test\s+run pane's menu[\s\S]*\*saved\*, not \*tested\*/);
    expect(testProjectScript).toMatch(/Test run pane's menu/);
    expect(testLoop).toMatch(/`up` retries it once through a restart/);
    expect(testLoop).toMatch(/Test Project's Environment settings/);
    expect(testLoop).toMatch(/never its value/);
    expect(testLoop).toMatch(/targets something the author owns and named in the brief/);
    expect(testLoop).toMatch(/use the result once the way the brief's user would/);
  });

  it('drives only routes this pod is actually allowed to call', () => {
    const open = gatewayOpenRoutes();
    const driven = [...platformCallsIn(testLoop), ...platformCallsIn(testProjectScript)];

    expect(open.size).toBeGreaterThan(5);
    expect(platformCallsIn(testProjectScript).length).toBeGreaterThan(8);
    for (const call of new Set(driven)) {
      expect([...open], `the test loop drives ${call}, which is not open to a gateway caller`).toContain(call);
    }
  });

  it('is matched by the authoring references, which drive the Skill and Agent routes', () => {
    const open = gatewayOpenRoutes();
    const agentApi = readFileSync(join(packageRoot, 'skills', 'agent-authoring', 'references', 'agent-api.md'), 'utf8');
    const driven = [
      ...platformCallsIn(skillApi),
      ...platformCallsIn(agentApi),
      ...platformCallsIn(skillAuthoring),
      ...platformCallsIn(templateReference),
    ];

    expect(driven.length).toBeGreaterThan(8);
    for (const call of new Set(driven)) {
      expect([...open], `a reference drives ${call}, which is not open to a gateway caller`).toContain(call);
    }
  });

  it('creates the Test Project the way the API accepts it, and waits with a ceiling', () => {
    expect(testLoop).toContain('sh scripts/tp.sh up');
    expect(testProjectScript).toContain('kind: "test"');
    expect(testProjectScript).toContain('api call POST /projects');
    expect(testProjectScript).toMatch(/environments\[0\]\.status/);
    expect(testProjectScript).toMatch(/wait_active\(\) \{[\s\S]*"\$attempts"[\s\S]*failed[\s\S]*return 1/);
  });

  it('prompts and reads through the runtime, and shells for verification', () => {
    expect(testLoop).toContain("sh scripts/tp.sh prompt '");
    expect(testProjectScript).toContain('/api/session/$session/prompt');
    expect(testProjectScript).toContain('exec sh "$here/turn.sh"');
    expect(testProjectScript).not.toMatch(/\/wait"/);
    expect(testProjectScript).toContain('POST /api/shell');
    expect(testProjectScript).toContain('timeout: 60000');
    expect(testProjectScript).toContain('/api/shell/$shell/output');
    expect(testLoop).toContain('sh scripts/tp.sh restart');
    expect(testLoop).toContain('`timeout` set to `1200000`');
    expect(testLoop).toMatch(/genuine stall only/);
    expect(testLoop).toMatch(/Wait only through `tp\.sh`/);
    expect(testLoop).toMatch(/\*\*Exit 5, a broken turn\*\*/);
    expect(turnScript).toContain('idle finish=$finish');
    expect(testLoop).toMatch(/A long turn is\s+not a stuck one/);
  });

  it('answers a Form the child opens from the brief and the expectations, and records it', () => {
    expect(testLoop).toContain('sh scripts/tp.sh answer \'{"<field key>":');
    expect(testProjectScript).toContain('"/api/session/$session/form"');
    expect(testProjectScript).toContain('"/api/session/$session/form/$form/reply"');
    expect(testLoop).toMatch(/The answer comes from the author's intent/);
    expect(testLoop).toMatch(/its position\s+and a "\(Recommended\)" label carry none/);
    expect(testLoop).toMatch(/Always answer a Form, never cancel it/);
    expect(testLoop).toMatch(/Note every Form in the round's report/);
    expect(testLoop).toContain('`question (open)`');
  });

  it('keeps one Test Project per chat, recovered from /me or the 409, and refreshed in place', () => {
    expect(testProjectScript).toContain('state=scratch/test-project.json');
    expect(testLoop).toMatch(/no Project list shows it/);
    expect(testProjectScript).toContain('.builderTestProject.id');
    expect(testProjectScript).toContain('.testProjectId');
    expect(testProjectScript).toContain('api call POST "/projects/$project/test/update"');
    expect(testProjectScript).toContain('api call POST "/projects/$project/test/reset"');
    expect(testProjectScript).not.toMatch(/DELETE/);
    expect(testLoop).not.toMatch(/supersede/i);
  });

  it('reads the child record through evidence.sh and grades the gaps itself', () => {
    expect(testLoop).toContain('sh scripts/tp.sh evidence');
    expect(testProjectScript).toContain('exec sh "$here/evidence.sh"');
    expect(testLoop).toMatch(/\*\*covered\*\*/);
    expect(testLoop).toMatch(/\*\*gap\*\*/);
    expect(testLoop).toMatch(/\*\*mine\*\* \(checked myself\) or \*\*the child's record\*\*/);
    expect(testLoop).toMatch(/passed after a Template update/);
    expect(testLoop).not.toMatch(/report each check you made/);
    expect(testLoop).not.toMatch(/set viewport 375/);
    expect(templateReference).toContain('sh scripts/check-template.sh');
    expect(templateReference).toMatch(/nothing to boot/);
  });
});

describe('the Builder instruction word budget', () => {
  const wordBudget: Record<string, number> = {
    'agent.md': 1450,
    'skills/agent-authoring/SKILL.md': 1600,
    'skills/agent-authoring/references/test-loop.md': 3750,
    'skills/agent-authoring/references/template.md': 1200,
    'skills/skill-authoring/SKILL.md': 1100,
  };

  it.each(Object.entries(wordBudget))('keeps %s within %i words', (file, budget) => {
    const words = readFileSync(join(packageRoot, file), 'utf8').split(/\s+/).filter(Boolean).length;
    expect(words).toBeLessThanOrEqual(budget);
  });
});
