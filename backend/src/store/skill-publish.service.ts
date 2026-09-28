import { BadRequestException, Injectable } from '@nestjs/common';
import { db } from '../../db';
import type { DbExecutor } from '../common/locks';
import { hashSkillTree, validateSkillTree, type GateResult, type SkillTree } from './gate';
import { parseFrontmatter } from './gate/frontmatter';
import { decodeText, SKILL_MANIFEST_PATH } from './gate/skill-tree';
import { reservedSkillNames } from './skill-reconciler.service';
import { SkillRepository } from './skill.repository';
import { manifestDescription } from './skill-tree';
import { nameUnavailable, validationFailed } from './store-errors';
import type { SkillRow } from './skill-visibility';

export interface PublishInput {
  tenantId: string;
  userId: string;
  tree: SkillTree;
  createdVia: string;
  sourceRef?: string | null;
}

export interface CreateInput extends PublishInput {
  name: string;
  displayName?: string | null;
}

export interface PublishResult {
  skillId: string;
  versionId: string;
  version: number;
}

@Injectable()
export class SkillPublishService {
  constructor(private readonly repository: SkillRepository) {}

  runGate(tree: SkillTree, expectedName?: string): GateResult {
    return validateSkillTree(tree, {
      ...(expectedName === undefined ? {} : { expectedName }),
      reservedNames: [...reservedSkillNames()],
    });
  }

  async assertNameAvailable(tenantId: string, name: string): Promise<void> {
    if (reservedSkillNames().has(name) || (await this.repository.nameTaken(tenantId, name))) {
      throw nameUnavailable(name);
    }
  }

  async create(input: CreateInput, executor: DbExecutor = db): Promise<PublishResult> {
    await this.assertNameAvailable(input.tenantId, input.name);
    const gate = this.gateOrThrow(input.tree, input.name);

    return this.repository.createSkillWithFirstVersion(
      {
        tenantId: input.tenantId,
        userId: input.userId,
        name: input.name,
        displayName: input.displayName ?? null,
        description: manifestDescription(gate.normalizedTree),
        tree: gate.normalizedTree,
        contentHash: hashSkillTree(gate.normalizedTree),
        flags: gate.flags,
        lints: gate.lints.map((lint) => lint.rule),
        createdVia: input.createdVia,
        sourceRef: input.sourceRef ?? null,
      },
      executor
    );
  }

  async createUnpublished(input: {
    tenantId: string;
    userId: string;
    name: string;
    displayName: string | null;
  }): Promise<string> {
    const invalid = this.runGate(nameOnlyTree(input.name), input.name).errors.find(
      (error) => error.rule === 'name_format' || error.rule === 'name_length'
    );
    if (invalid) throw new BadRequestException({ code: 'bad_request', message: invalid.message });
    await this.assertNameAvailable(input.tenantId, input.name);
    return this.repository.createSkillWithoutVersion(input);
  }

  async addVersion(skill: SkillRow, input: PublishInput, executor: DbExecutor = db): Promise<PublishResult> {
    const gate = this.gateOrThrow(input.tree, skill.name);

    const { versionId, version } = await this.repository.mintNextVersion(
      {
        skillId: skill.id,
        userId: input.userId,
        description: manifestDescription(gate.normalizedTree),
        tree: gate.normalizedTree,
        contentHash: hashSkillTree(gate.normalizedTree),
        flags: gate.flags,
        lints: gate.lints.map((lint) => lint.rule),
        createdVia: input.createdVia,
        sourceRef: input.sourceRef ?? null,
      },
      executor
    );
    return { skillId: skill.id, versionId, version };
  }

  private gateOrThrow(tree: SkillTree, expectedName: string): GateResult {
    const gate = this.runGate(tree, expectedName);
    if (gate.errors.length > 0) throw validationFailed(gate.errors, gate.lints);
    return gate;
  }
}

function nameOnlyTree(name: string): SkillTree {
  return [{ path: SKILL_MANIFEST_PATH, content: Buffer.from(`---\nname: ${name}\n---\n`, 'utf8'), executable: false }];
}

export function manifestName(tree: SkillTree): string | null {
  const entry = frontmatterEntry(tree, 'name');
  return entry ? entry.trim() || null : null;
}

export function manifestSourceRef(tree: SkillTree): string | null {
  const metadata = frontmatterEntry(tree, 'metadata');
  if (!metadata) return null;
  const match = /(?:^|\s)source:\s*(\S+)/.exec(metadata);
  return match ? match[1] : null;
}

function frontmatterEntry(tree: SkillTree, key: string): string | null {
  const manifest = tree.find((file) => file.path === SKILL_MANIFEST_PATH);
  if (!manifest) return null;
  const entry = parseFrontmatter(decodeText(manifest.content)).entries.findLast((candidate) => candidate.key === key);
  return entry?.value ?? null;
}
