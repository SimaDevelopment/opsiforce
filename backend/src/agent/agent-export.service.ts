import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import archiver from 'archiver';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../../db';
import { skillVersions, skills } from '../../db/schema';
import { AgentTemplateStore } from '../agent-template/agent-template.store';
import { fileMode, REGULAR_FILE_MODE } from '../common/fs';
import { packSkill, scanKeyLike, type SkillTree } from '../store/gate';
import { SkillRepository } from '../store/skill.repository';
import { notExportable } from './agent-errors';
import {
  AGENT_EXPORT_FORMAT_VERSION,
  AGENT_EXPORT_KIND,
  AGENT_EXPORT_MANIFEST,
  AGENT_EXPORT_TEMPLATE_DIR,
  agentExportFileName,
  agentExportSkillFile,
  type AgentExportFile,
  type AgentExportManifest,
  type AgentExportPreview,
  type AgentExportSkillOrigin,
} from './agent-export';
import type { AgentBundle, AgentBundleSkillReference } from './agent-bundle';
import { AgentBundleReader } from './agent-bundle.reader';
import { assertAgentVisibleToUser } from './agent-visibility';
import type { AgentCaller, AgentRow } from './agent.types';

interface ExportedSkill {
  name: string;
  origin: AgentExportSkillOrigin;
  contentHash: string;
  tree: SkillTree | null;
}

interface ExportContents {
  agent: AgentRow;
  bundle: AgentBundle;
  template: SkillTree | null;
  skills: ExportedSkill[];
}

@Injectable()
export class AgentExportService {
  private readonly platformVersion: string;
  private readonly agentImageVersion: string;
  private readonly arch: string;

  constructor(
    configService: ConfigService,
    private readonly bundleReader: AgentBundleReader,
    private readonly templates: AgentTemplateStore,
    private readonly skillRepository: SkillRepository
  ) {
    this.platformVersion = configService.get<string>('platformVersion', '0.1.0');
    this.agentImageVersion = configService.get<string>('agentImageVersion', this.platformVersion);
    this.arch = configService.get<string>('arch', process.arch);
  }

  async export(caller: AgentCaller, agentId: string): Promise<AgentExportFile> {
    const contents = await this.read(caller, agentId);
    const manifest = this.manifest(contents);
    return { fileName: agentExportFileName(contents.agent.name), archive: await packExport(manifest, contents) };
  }

  async preview(caller: AgentCaller, agentId: string): Promise<AgentExportPreview> {
    const contents = await this.read(caller, agentId);
    return {
      template: contents.template ? scanKeyLike(contents.template) : [],
      skills: contents.skills.flatMap((skill) => {
        const hits = skill.tree ? scanKeyLike(skill.tree) : [];
        return hits.length > 0 ? [{ name: skill.name, hits }] : [];
      }),
    };
  }

  private async read(caller: AgentCaller, agentId: string): Promise<ExportContents> {
    const agent = await assertAgentVisibleToUser(caller.tenantId, caller.userId, agentId);
    if (agent.origin !== 'custom') throw notExportable(agent.displayName ?? agent.name);

    const bundle = await this.bundleReader.read(agent, caller.tenantId);
    const template = bundle.template
      ? await this.templates.readVersionTree(bundle.template.sourceDir, bundle.template.hash)
      : null;
    return { agent, bundle, template, skills: await this.readSkills(bundle.skills) };
  }

  private async readSkills(references: AgentBundleSkillReference[]): Promise<ExportedSkill[]> {
    if (references.length === 0) return [];
    const rows = await db
      .select({ versionId: skillVersions.id, origin: skills.origin, contentHash: skillVersions.contentHash })
      .from(skillVersions)
      .innerJoin(skills, eq(skills.id, skillVersions.skillId))
      .where(
        inArray(
          skillVersions.id,
          references.map((reference) => reference.skillVersionId)
        )
      );
    const byVersion = new Map(rows.map((row) => [row.versionId, row]));

    const exported: ExportedSkill[] = [];
    for (const reference of references.toSorted((a, b) => a.name.localeCompare(b.name))) {
      const row = byVersion.get(reference.skillVersionId);
      if (!row) continue;
      const origin = row.origin === 'custom' ? 'custom' : 'built_in';
      exported.push({
        name: reference.name,
        origin,
        contentHash: row.contentHash,
        tree: origin === 'custom' ? await this.skillRepository.readTree(reference.skillVersionId) : null,
      });
    }
    return exported;
  }

  private manifest({ agent, bundle, skills: exported }: ExportContents): AgentExportManifest {
    return {
      kind: AGENT_EXPORT_KIND,
      stamp: {
        exportFormatVersion: AGENT_EXPORT_FORMAT_VERSION,
        platformVersion: this.platformVersion,
        agentImageVersion: this.agentImageVersion,
        arch: this.arch,
      },
      agent: {
        displayName: bundle.identity.displayName,
        slug: agent.name,
        description: bundle.identity.description,
        platformApi: bundle.identity.platformApi,
      },
      profile: bundle.profile,
      skills: exported.map((skill) => ({
        name: skill.name,
        origin: skill.origin,
        contentHash: skill.contentHash,
        ...(skill.tree ? { file: agentExportSkillFile(skill.name) } : {}),
      })),
      template: bundle.template ? { hash: bundle.template.hash } : null,
    };
  }
}

async function packExport(manifest: AgentExportManifest, contents: ExportContents): Promise<Buffer> {
  const skillPacks = await Promise.all(
    contents.skills.flatMap((skill) =>
      skill.tree ? [packSkill(skill.tree).then((pack) => ({ name: agentExportSkillFile(skill.name), pack }))] : []
    )
  );

  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const chunks: Buffer[] = [];
    archive.on('data', (chunk: Buffer) => chunks.push(chunk));
    archive.on('warning', reject);
    archive.on('error', reject);
    archive.on('end', () => resolve(Buffer.concat(chunks)));

    archive.append(JSON.stringify(manifest, null, 2), { name: AGENT_EXPORT_MANIFEST, mode: REGULAR_FILE_MODE });
    for (const file of contents.template ?? []) {
      archive.append(file.content, {
        name: `${AGENT_EXPORT_TEMPLATE_DIR}/${file.path}`,
        mode: fileMode(file.executable),
      });
    }
    for (const { name, pack } of skillPacks) archive.append(pack, { name, mode: REGULAR_FILE_MODE });
    void archive.finalize();
  });
}
