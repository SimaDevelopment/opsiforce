import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rm, statfs } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { HttpException, Injectable } from '@nestjs/common';
import type yauzl from 'yauzl';
import { ConfigService } from '@nestjs/config';
import { hashSkillTree, SkillArchiveError, unpackSkill, type SkillTree } from '../store/gate';
import { MAX_TREE_BYTES } from '../store/gate/skill-tree';
import { SkillPublishService, manifestSourceRef } from '../store/skill-publish.service';
import { reservedSkillNames } from '../store/skill-reconciler.service';
import { SkillRepository } from '../store/skill.repository';
import { canEditSkill, type SkillRow } from '../store/skill-visibility';
import { scanTemplateSource } from '../agent-template/template-source';
import { AgentTemplateStore } from '../agent-template/agent-template.store';
import { importsRootPath } from '../project/project-import.types';
import { EXECUTABLE_FILE_MODE } from '../common/fs';
import type { DbExecutor } from '../common/locks';
import {
  collectEntries,
  entryMode,
  isSymlinkMode,
  openZip,
  readEntry,
  readNamedEntry,
  writeEntryToFile,
} from '../common/zip-reader';
import { assertModelSelection } from './agent-models';
import { defaultProfileModel } from './agent-config';
import { AgentBundleWriter } from './agent-bundle.writer';
import type { AgentBundle, AgentBundleProfile, SkillPin } from './agent-bundle';
import {
  AGENT_EXPORT_FORMAT_VERSION,
  AGENT_EXPORT_KIND,
  AGENT_EXPORT_MANIFEST,
  AGENT_EXPORT_SKILLS_DIR,
  AGENT_EXPORT_TEMPLATE_DIR,
  type AgentExportManifest,
  type AgentExportManifestSkill,
} from './agent-export';
import {
  exportFormatUnsupported,
  importRefused,
  notAnAgentExport,
  type AgentImportNote,
  type AgentImportProblem,
  type AgentImportResult,
} from './agent-import';
import { AgentService } from './agent.service';
import type { AgentCaller } from './agent.types';

const TEMPLATE_PREFIX = `${AGENT_EXPORT_TEMPLATE_DIR}/`;
const SKILLS_PREFIX = `${AGENT_EXPORT_SKILLS_DIR}/`;
const FREE_SPACE_RESERVE_BYTES = 512 * 1024 * 1024;

interface ArchiveContents {
  templateDir: string;
  skillPacks: Map<string, Buffer>;
  problems: AgentImportProblem[];
}

type SkillWrite = { name: string; tree: SkillTree } & ({ into: 'new' } | { into: 'existing'; skill: SkillRow });

interface ImportPlan {
  displayName: string;
  bundle: AgentBundle;
  pins: SkillPin[];
  skillWrites: SkillWrite[];
  notes: AgentImportNote[];
  problems: AgentImportProblem[];
}

@Injectable()
export class AgentImportService {
  private readonly importsRoot: string;

  constructor(
    configService: ConfigService,
    private readonly agents: AgentService,
    private readonly writer: AgentBundleWriter,
    private readonly templates: AgentTemplateStore,
    private readonly skillRepository: SkillRepository,
    private readonly skillPublish: SkillPublishService
  ) {
    this.importsRoot = importsRootPath(configService.getOrThrow<string>('storageMountPath'));
  }

  async import(caller: AgentCaller, archivePath: string, displayName: string | null): Promise<AgentImportResult> {
    const manifest = await readAgentManifest(archivePath);
    const workDir = join(this.importsRoot, `.agent-import-${randomUUID()}`);
    try {
      const contents = await extractArchive(archivePath, join(workDir, AGENT_EXPORT_TEMPLATE_DIR));
      const plan = await this.resolve(caller, manifest, contents, displayName);
      if (plan.problems.length > 0) throw importRefused(plan.problems, nameFromFile(manifest));

      const agentId = await this.writer.write(caller, {
        displayName: plan.displayName,
        bundle: plan.bundle,
        pins: plan.pins,
        writeSkills: (tx) => this.writeSkills(caller, plan.skillWrites, tx),
      });
      return { agent: await this.agents.findOne(caller, agentId), notes: plan.notes };
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  private async resolve(
    caller: AgentCaller,
    manifest: AgentExportManifest,
    contents: ArchiveContents,
    requestedName: string | null
  ): Promise<ImportPlan> {
    const plan: ImportPlan = {
      displayName: requestedName?.trim() || nameFromFile(manifest),
      bundle: {
        identity: {
          displayName: manifest.agent.displayName,
          description: manifest.agent.description,
          platformApi: manifest.agent.platformApi === true,
        },
        profile: manifest.profile,
        skills: [],
        template: null,
      },
      pins: [],
      skillWrites: [],
      notes: [],
      problems: [...contents.problems],
    };

    await this.resolveName(caller, plan);
    resolveModel(plan);
    for (const skill of manifest.skills) await this.resolveSkill(caller, skill, contents.skillPacks, plan);
    if (!contents.problems.some((problem) => problem.kind === 'template')) {
      await this.resolveTemplate(manifest, contents.templateDir, plan);
    }
    return plan;
  }

  private async resolveName(caller: AgentCaller, plan: ImportPlan): Promise<void> {
    try {
      plan.displayName = (await this.writer.availableName(caller.tenantId, plan.displayName)).displayName;
    } catch (error) {
      if (!(error instanceof HttpException)) throw error;
      plan.problems.push({ kind: 'name', name: plan.displayName, message: refusalMessage(error) });
    }
  }

  private async resolveSkill(
    caller: AgentCaller,
    skill: AgentExportManifestSkill,
    packs: Map<string, Buffer>,
    plan: ImportPlan
  ): Promise<void> {
    if (skill.origin === 'built_in') await this.resolveBuiltInSkill(skill, plan);
    else await this.resolveCustomSkill(caller, skill, packs.get(skill.name), plan);
  }

  private async resolveBuiltInSkill(skill: AgentExportManifestSkill, plan: ImportPlan): Promise<void> {
    const [shipped] = await this.skillRepository.builtInLatestVersions([skill.name]);
    if (!shipped) {
      plan.problems.push({
        kind: 'skill',
        name: skill.name,
        message: `This deployment doesn't ship the Built-in Skill \`${skill.name}\``,
      });
      return;
    }

    const matching = await this.skillRepository.versionWithHash(shipped.skillId, skill.contentHash);
    plan.pins.push({ skillId: shipped.skillId, skillVersionId: matching ?? shipped.skillVersionId });
    if (!matching) {
      plan.notes.push({
        kind: 'skill',
        name: skill.name,
        message: `The Built-in Skill \`${skill.name}\` differs here from the exporting deployment, so the Agent pins its current Version`,
      });
    }
  }

  private async resolveCustomSkill(
    caller: AgentCaller,
    skill: AgentExportManifestSkill,
    pack: Buffer | undefined,
    plan: ImportPlan
  ): Promise<void> {
    const refuse = (message: string) => plan.problems.push({ kind: 'skill', name: skill.name, message });

    if (reservedSkillNames().has(skill.name)) return void refuse(`\`${skill.name}\` is a reserved Skill name here`);
    if (!pack) return void refuse(`The file doesn't carry \`${skill.name}\`'s Skill pack`);

    let tree: SkillTree;
    try {
      tree = await unpackSkill(pack);
    } catch (error) {
      if (!(error instanceof SkillArchiveError)) throw error;
      return void refuse(`\`${skill.name}\`'s Skill pack can't be read: ${error.message}`);
    }
    const gate = this.skillPublish.runGate(tree, skill.name);
    if (gate.errors.length > 0) {
      return void refuse(`\`${skill.name}\` doesn't pass the Skill gate: ${gate.errors[0].message}`);
    }
    const normalized = gate.normalizedTree;
    const contentHash = hashSkillTree(normalized);
    if (contentHash !== skill.contentHash) {
      return void refuse(
        `\`${skill.name}\`'s Skill pack doesn't match the hash in manifest.json, so the file was changed after export; export it again`
      );
    }

    const existing = await this.skillRepository.findByName(caller.tenantId, skill.name);
    if (!existing) {
      plan.skillWrites.push({ name: skill.name, tree: normalized, into: 'new' });
      plan.notes.push({ kind: 'skill', name: skill.name, message: `Created your private Skill \`${skill.name}\`` });
      return;
    }
    if (existing.disabled)
      return void refuse(`The Skill \`${skill.name}\` is disabled here; enable it and import again`);
    if (!canEditSkill(existing, caller.userId)) {
      return void refuse(`A Skill named \`${skill.name}\` already exists here and you can't edit it`);
    }

    const matching = await this.skillRepository.versionWithHash(existing.id, contentHash);
    if (matching) {
      plan.pins.push({ skillId: existing.id, skillVersionId: matching });
      return;
    }
    plan.skillWrites.push({ name: skill.name, tree: normalized, into: 'existing', skill: existing });
    plan.notes.push({
      kind: 'skill',
      name: skill.name,
      message: `Published a new Version of your Skill \`${skill.name}\` with the file's content`,
    });
  }

  private async resolveTemplate(manifest: AgentExportManifest, templateDir: string, plan: ImportPlan): Promise<void> {
    const source = await scanTemplateSource(templateDir);
    if (source.refused.length > 0) {
      for (const refusal of source.refused) {
        plan.problems.push({
          kind: 'template',
          path: refusal.path,
          message: `template/${refusal.path}: ${refusal.reason}`,
        });
      }
      return;
    }

    const hash = source.files.length > 0 ? await this.templates.hashSource(templateDir) : null;
    if (hash !== (manifest.template?.hash ?? null)) {
      plan.problems.push({
        kind: 'template',
        message:
          "The Template's files don't match the hash in manifest.json, so the file was changed after export; export it again",
      });
      return;
    }
    plan.bundle.template = hash ? { hash, sourceDir: templateDir } : null;
    for (const skipped of source.skipped) {
      plan.notes.push({
        kind: 'template',
        path: skipped.path,
        message: `Left \`template/${skipped.path}\` out of the Template: ${skipped.reason}`,
      });
    }
  }

  private async writeSkills(caller: AgentCaller, writes: SkillWrite[], tx: DbExecutor): Promise<SkillPin[]> {
    const pins: SkillPin[] = [];
    for (const write of writes) {
      const input = {
        tenantId: caller.tenantId,
        userId: caller.userId,
        tree: write.tree,
        createdVia: 'import',
        sourceRef: manifestSourceRef(write.tree),
      };
      const published =
        write.into === 'new'
          ? await this.skillPublish.create({ ...input, name: write.name }, tx)
          : await this.skillPublish.addVersion(write.skill, input, tx);
      pins.push({ skillId: published.skillId, skillVersionId: published.versionId });
    }
    return pins;
  }
}

function nameFromFile(manifest: AgentExportManifest): string {
  return manifest.agent.displayName?.trim() || manifest.agent.slug;
}

function refusalMessage(error: HttpException): string {
  const response = error.getResponse();
  if (typeof response === 'object' && response !== null && 'message' in response) {
    return String((response as { message: unknown }).message);
  }
  return error.message;
}

function resolveModel(plan: ImportPlan): void {
  const profile: AgentBundleProfile = plan.bundle.profile;
  try {
    assertModelSelection(profile.model, profile.variant);
  } catch (error) {
    if (!(error instanceof HttpException)) throw error;
    const fallback = defaultProfileModel();
    plan.bundle.profile = { ...profile, ...fallback };
    plan.notes.push({
      kind: 'model',
      message: `This deployment doesn't offer \`${profile.model}\`${profile.variant ? ` (${profile.variant})` : ''}, so the Agent uses the default \`${fallback.model}\``,
    });
  }
}

async function readAgentManifest(archivePath: string): Promise<AgentExportManifest> {
  let parsed: unknown;
  try {
    const zip = await openZip(archivePath);
    try {
      const buffer = await readNamedEntry(zip, AGENT_EXPORT_MANIFEST);
      if (!buffer) throw notAnAgentExport("The file isn't an export: it has no manifest.json");
      parsed = JSON.parse(buffer.toString('utf8'));
    } finally {
      zip.close();
    }
  } catch (error) {
    if (error instanceof HttpException) throw error;
    throw notAnAgentExport("The file isn't a readable export zip");
  }
  return assertAgentManifest(parsed);
}

export function assertAgentManifest(parsed: unknown): AgentExportManifest {
  if (typeof parsed !== 'object' || parsed === null) throw notAnAgentExport('manifest.json is malformed');
  const manifest = parsed as Partial<AgentExportManifest> & { kind?: unknown };

  if (manifest.kind !== AGENT_EXPORT_KIND) {
    throw notAnAgentExport(
      manifest.kind === undefined || manifest.kind === 'project'
        ? 'This is a Project export; import it from Projects'
        : `This is a \`${String(manifest.kind)}\` export, not an Agent export`
    );
  }

  const version = manifest.stamp?.exportFormatVersion;
  if (typeof version !== 'number') throw notAnAgentExport('manifest.json has no exportFormatVersion');
  if (version > AGENT_EXPORT_FORMAT_VERSION) throw exportFormatUnsupported(version, AGENT_EXPORT_FORMAT_VERSION);

  const { agent, profile, skills: carried, template } = manifest;
  const wellFormed =
    typeof agent?.slug === 'string' &&
    isOptionalString(agent.displayName) &&
    isOptionalString(agent.description) &&
    (agent.platformApi === undefined || typeof agent.platformApi === 'boolean') &&
    typeof profile?.promptBody === 'string' &&
    typeof profile.model === 'string' &&
    (profile.variant === null || typeof profile.variant === 'string') &&
    Array.isArray(carried) &&
    carried.every(
      (skill) =>
        typeof skill?.name === 'string' &&
        typeof skill.contentHash === 'string' &&
        (skill.origin === 'built_in' || skill.origin === 'custom')
    ) &&
    (template === null || typeof template?.hash === 'string');
  if (!wellFormed) throw notAnAgentExport('manifest.json is malformed');
  return manifest as AgentExportManifest;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string';
}

async function fitsOnVolume(root: string, entries: yauzl.Entry[]): Promise<boolean> {
  const declared = entries
    .filter((entry) => entry.fileName.startsWith(TEMPLATE_PREFIX))
    .reduce((total, entry) => total + entry.uncompressedSize, 0);
  const volume = await statfs(root);
  return declared <= volume.bavail * volume.bsize - FREE_SPACE_RESERVE_BYTES;
}

async function extractArchive(archivePath: string, templateDir: string): Promise<ArchiveContents> {
  const contents: ArchiveContents = { templateDir, skillPacks: new Map(), problems: [] };
  const root = resolve(templateDir);
  await mkdir(root, { recursive: true });

  const zip = await openZip(archivePath);
  try {
    const entries = await collectEntries(zip);
    const templateFits = await fitsOnVolume(root, entries);
    if (!templateFits) {
      contents.problems.push({
        kind: 'template',
        message: "The Template unpacks to more than this deployment's storage has room for",
      });
    }
    for (const entry of entries) {
      if (entry.fileName.endsWith('/')) continue;

      if (entry.fileName.startsWith(SKILLS_PREFIX) && entry.fileName.endsWith('.zip')) {
        const name = entry.fileName.slice(SKILLS_PREFIX.length, -'.zip'.length);
        if (entry.uncompressedSize > MAX_TREE_BYTES) {
          contents.problems.push({ kind: 'skill', name, message: `\`${name}\`'s Skill pack is too large` });
          continue;
        }
        contents.skillPacks.set(name, await readEntry(zip, entry));
        continue;
      }

      if (!templateFits || !entry.fileName.startsWith(TEMPLATE_PREFIX)) continue;
      const relative = entry.fileName.slice(TEMPLATE_PREFIX.length);
      const target = resolve(root, relative);
      const mode = entryMode(entry);
      if (!target.startsWith(root + sep) || isSymlinkMode(mode)) {
        contents.problems.push({
          kind: 'template',
          path: relative,
          message: `template/${relative}: only regular files inside template/ can be imported`,
        });
        continue;
      }
      await mkdir(dirname(target), { recursive: true });
      await writeEntryToFile(zip, entry, target);
      if (mode & 0o111) await chmod(target, EXECUTABLE_FILE_MODE);
    }
  } catch (error) {
    if (error instanceof HttpException) throw error;
    throw notAnAgentExport(`The file can't be unpacked: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    zip.close();
  }
  return contents;
}
