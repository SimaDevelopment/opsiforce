import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  fieldTypes,
  generatedAlphabets,
  hookNames,
  inputFormats,
  operationKinds,
  serviceErrorStatuses,
  serviceTestReportPath,
  testReportResults,
  testReportSources,
  textFormats,
} from '@opsiforce/external-service-sdk/platform';
import { describe, expect, it } from 'vitest';
import { validateSkillTree } from '../../src/store/gate';
import { packageSkillNames, readSkillTree } from '../../src/store/skill-tree';

const agentConfig = join(process.cwd(), '..', 'agent-config');
const builderPackage = join(agentConfig, 'agents', 'external-service-builder');
const skillRoot = join(builderPackage, 'skills', 'external-service-authoring');
const builtInServices = join(process.cwd(), '..', 'external-services');
const templateApp = join(builderPackage, 'template', 'app');
const dockerfile = readFileSync(join(process.cwd(), '..', 'docker', 'Dockerfile.agent'), 'utf8');

function read(path: string): string {
  return readFileSync(join(skillRoot, path), 'utf8');
}

const skill = read('SKILL.md');
const manifest = read('references/manifest.md');
const handlers = read('references/handlers.md');
const inbound = read('references/inbound.md');
const reviewStops = read('references/review-stops.md');
const patterns = read('references/patterns.md');
const serviceSkill = read('references/service-skill.md');
const everything = [skill, manifest, handlers, inbound, reviewStops, patterns, serviceSkill].join('\n');

function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(`\n${heading}\n`);
  if (start === -1) return '';
  const next = markdown.indexOf('\n## ', start + heading.length + 2);
  return markdown.slice(start, next === -1 ? undefined : next);
}

function builtInFolders(): string[] {
  return readdirSync(builtInServices, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules')
    .map((entry) => join(builtInServices, entry.name));
}

function backticked(markdown: string): Set<string> {
  return new Set([...markdown.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]));
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

  it('points at the SDK copy and the built-in references where the agent image lays them', () => {
    expect(skill).toContain('/opt/opsiforce/external-service-sdk/latest/');
    expect(skill).toContain('/opt/agents/external-service-builder/reference/');
    expect(dockerfile).toContain('/opt/opsiforce/external-service-sdk/');
    expect(dockerfile).toContain('/opt/agents/external-service-builder/reference/');
  });
});

describe('the references against the SDK v1 contract', () => {
  it('teach every field type, text format and generated alphabet of the field catalog', () => {
    const named = backticked(manifest);

    expect(fieldTypes.filter((type) => !named.has(type))).toEqual([]);
    expect(textFormats.filter((format) => !named.has(format))).toEqual([]);
    expect(generatedAlphabets.filter((alphabet) => !named.has(alphabet))).toEqual([]);
  });

  it('teach every Operation kind and every input format of the safe schema profile', () => {
    const named = backticked(manifest);

    expect(operationKinds.filter((kind) => !named.has(kind))).toEqual([]);
    expect(inputFormats.filter((format) => !named.has(format))).toEqual([]);
  });

  it('teach the four bound path shapes', () => {
    for (const shape of ['boardIds', 'workspace', 'channels[].chats', 'where', 'unless']) {
      expect(manifest).toContain(shape);
    }
  });

  it('teach every status a ServiceError keeps, and the save hooks by name', () => {
    expect(serviceErrorStatuses.filter((status) => !handlers.includes(String(status)))).toEqual([]);
    expect(hookNames.filter((name) => !handlers.includes(name))).toEqual([]);
  });

  it('teach every ctx member the handlers receive', () => {
    for (const member of [
      'ctx.serviceConfiguration',
      'ctx.projectConfiguration',
      'ctx.bounds',
      'ctx.caller',
      'ctx.callId',
      'ctx.signal',
      'ctx.webhookUrl',
      'ctx.log',
      'ctx.state',
      'ctx.file',
    ]) {
      expect(handlers).toContain(member);
    }
  });

  it('teach the refusals the test kit answers exactly as the Gate does', () => {
    for (const code of ['unknown-operation', 'operation-off', 'input-too-large', 'invalid-input', 'out-of-bounds']) {
      expect(handlers).toContain(code);
    }
  });

  it('teach the test report line shape the Publish dialog reads', () => {
    const named = backticked(reviewStops);

    expect(reviewStops).toContain(serviceTestReportPath);
    expect(testReportResults.filter((result) => !named.has(result))).toEqual([]);
    expect(testReportSources.filter((source) => !named.has(source))).toEqual([]);
  });

  it('teach every CLI command the service folder runs', () => {
    for (const command of ['types', 'check', 'dev', 'serve', 'report', 'generate --from-openapi']) {
      expect(everything).toContain(`external-service-cli ${command}`);
    }
  });

  it('teach the Service skill as the layer over what the Gate serves live', () => {
    expect(skill).toContain('references/service-skill.md');
    for (const source of ['describe', 'openapi.json', 'Calling it', 'data']) {
      expect(serviceSkill).toContain(source);
    }
  });

  it('teach inbound through the one handler and its Event shape', () => {
    for (const term of ['"inbound": true', 'rawBody', 'occurredAt', 'response', '401']) {
      expect(inbound).toContain(term);
    }
  });
});

describe('the service folder layout', () => {
  const layout = section(skill, '## Layout');

  it('is the rule of the skill, pointed to from its file table', () => {
    expect(layout).not.toBe('');
    expect(skill.slice(0, skill.indexOf('\n## '))).toContain('§Layout');
    for (const part of [
      'handlers.ts',
      'src/',
      'client.ts',
      'bounds.ts',
      'operations/<area>.ts',
      'forms.ts',
      'hooks.ts',
      'inbound.ts',
      'fixtures/',
      'README.md',
    ]) {
      expect(layout).toContain(part);
    }
  });

  it('is the shape of every built-in, the builder’s worked examples', () => {
    const layoutEntries = new Set([
      'service.json',
      'service.types.ts',
      'openapi-routes.json',
      'handlers.ts',
      'src',
      'test',
      'SKILL.md',
      'README.md',
      'icon.svg',
    ]);
    const strays = builtInFolders().flatMap((folder) =>
      readdirSync(folder)
        .filter((entry) => !layoutEntries.has(entry))
        .map((entry) => join(folder, entry))
    );

    expect(builtInFolders().length).toBeGreaterThan(0);
    expect(strays).toEqual([]);
  });

  it('keeps handlers.ts wiring names to functions in the built-ins and the template', () => {
    const withLogic = [templateApp, ...builtInFolders()]
      .map((folder) => join(folder, 'handlers.ts'))
      .filter((file) => /=>|\bfunction\b|\bawait\b|\bif\s*\(/.test(readFileSync(file, 'utf8')));

    expect(withLogic).toEqual([]);
  });
});
