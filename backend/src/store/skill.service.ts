import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { MissingPermissionException } from '../permission/missing-permission.exception';
import { Perms } from '../permission/permission.constants';
import { CATALOG_LIST_FILTERS } from './catalog-filters';
import { packSkill, SkillArchiveError, unpackSkill, type SkillTree } from './gate';
import { isTextFile } from './gate/skill-tree';
import { readMergedAgentRegistry } from '../agent/agent-config';
import { ServiceSkillAvailability } from './service-skill-availability';
import { packageSkillNames } from './skill-tree';
import { manifestName, manifestSourceRef, SkillPublishService } from './skill-publish.service';
import {
  SkillRepository,
  type BuiltInAgentIdentity,
  type SkillListRow,
  type SkillVersionRow,
} from './skill.repository';
import {
  assertSkillVisibleToUser,
  canDisableSkill,
  canEditSkill,
  isRetiredSkill,
  isServiceSkill,
  type SkillRow,
} from './skill-visibility';
import { isWithinCallingProject } from './calling-project';
import {
  nameUnavailable,
  notDisableable,
  outsideCallingProject,
  serviceSkillReadOnly,
  skillInUse,
  validationFailed,
  visibilityIncoherent,
} from './store-errors';
import type {
  CreateSkillDto,
  CreateSkillVersionDto,
  DuplicateSkillDto,
  GateResponse,
  SetSkillVisibilityDto,
  SkillAgentUsage,
  SkillExport,
  SkillFileInput,
  SkillFileResponse,
  SkillListFilter,
  SkillSummary,
  SkillVersionResponse,
  UpdateSkillDto,
  ValidateSkillDto,
} from './skill.types';

interface SkillShipper extends BuiltInAgentIdentity {
  ships: Set<string>;
}

export interface SkillCaller {
  tenantId: string;
  userId: string;
  canManageSkills: boolean;
  callingProjectId?: string;
}

interface Availability {
  services: ReadonlySet<string>;
}

@Injectable()
export class SkillService {
  constructor(
    private readonly repository: SkillRepository,
    private readonly publishService: SkillPublishService,
    private readonly serviceSkillAvailability: ServiceSkillAvailability
  ) {}

  async list(caller: SkillCaller, rawFilter: string | undefined, query: string | undefined): Promise<SkillSummary[]> {
    const filter = parseFilter(rawFilter);
    if (filter === 'disabled' && !caller.canManageSkills) throw new MissingPermissionException(Perms.manageSkills);

    const rows = await this.repository.list(caller.tenantId, caller.userId, filter, query);
    const availability = await this.availability(caller.tenantId);
    const shippers = await this.shippers();
    return rows.map((row) => toSummary(row, availability, shippers, caller.userId));
  }

  async findOne(caller: SkillCaller, skillId: string): Promise<SkillSummary> {
    await assertSkillVisibleToUser(caller.tenantId, caller.userId, skillId);
    const row = await this.repository.findOne(caller.tenantId, caller.userId, skillId);
    if (!row) throw new NotFoundException(`Skill ${skillId} not found`);
    return toSummary(row, await this.availability(caller.tenantId), await this.shippers(), caller.userId);
  }

  async listAgents(caller: SkillCaller, skillId: string): Promise<SkillAgentUsage[]> {
    const skill = await assertSkillVisibleToUser(caller.tenantId, caller.userId, skillId);
    const pins = await this.repository.agentPins(skillId, caller.tenantId, caller.userId);
    const omissions = await this.repository.omissionCountsByAgent(skill.name, caller.tenantId);
    const shipping = skill.origin === 'built_in' ? shippersOf(await this.shippers(), skill.name) : [];
    const shippingIds = new Set(shipping.map((agent) => agent.id));
    const byAgent = new Map<string, SkillAgentUsage>();

    for (const agent of shipping) {
      byAgent.set(agent.id, {
        id: agent.id,
        name: agent.name,
        displayName: agent.displayName,
        shipped: true,
        pinnedVersions: [],
        outdated: false,
        omittedIn: omissions.get(agent.id) ?? 0,
      });
    }

    for (const pin of pins) {
      const behind = pin.versionId !== skill.latestVersionId;
      const existing = byAgent.get(pin.id);
      if (existing) {
        existing.pinnedVersions.push(pin.version);
        existing.outdated ||= behind && !shippingIds.has(pin.id);
        continue;
      }
      byAgent.set(pin.id, {
        id: pin.id,
        name: pin.name,
        displayName: pin.displayName,
        shipped: false,
        pinnedVersions: [pin.version],
        outdated: behind,
        omittedIn: omissions.get(pin.id) ?? 0,
      });
    }

    return [...byAgent.values()].toSorted((left, right) => agentLabel(left).localeCompare(agentLabel(right)));
  }

  /** Which skills each Built-in Agent's image package ships: they reach its Projects without any pin (ADR-0060). */
  private async shippers(): Promise<SkillShipper[]> {
    const registered = await this.repository.builtInAgentsNamed(Object.keys(readMergedAgentRegistry().agents));
    return registered.map((agent) => Object.assign(agent, { ships: packageSkillNames(agent.name) }));
  }

  async listVersions(caller: SkillCaller, skillId: string): Promise<SkillVersionResponse[]> {
    const skill = await assertSkillVisibleToUser(caller.tenantId, caller.userId, skillId);
    const versions = await this.repository.listVersions(skillId);
    return versions.map((version) => toVersionResponse(version, skill));
  }

  async listFiles(caller: SkillCaller, skillId: string, version: number): Promise<SkillFileResponse[]> {
    const row = await this.resolveVersion(caller, skillId, version);
    const files = await this.repository.listFiles(row.id);
    return files.map((file) => {
      const content = Buffer.from(file.content);
      return {
        path: file.path,
        content: file.isBinary ? content.toString('base64') : content.toString('utf8'),
        isBinary: file.isBinary,
        isExecutable: file.isExecutable,
        size: file.size,
      };
    });
  }

  async exportVersion(caller: SkillCaller, skillId: string, version: number): Promise<SkillExport> {
    const skill = await assertSkillVisibleToUser(caller.tenantId, caller.userId, skillId);
    const row = await this.findVersionOrThrow(skillId, version);
    const tree = await this.repository.readTree(row.id);
    return { fileName: `${skill.name}-v${row.version}.skill`, archive: await packSkill(tree) };
  }

  validate(dto: ValidateSkillDto): GateResponse {
    const gate = this.publishService.runGate(readTree(dto.files), dto.name);
    return { valid: gate.errors.length === 0, errors: gate.errors, lints: gate.lints, flags: gate.flags };
  }

  async create(caller: SkillCaller, dto: CreateSkillDto): Promise<SkillSummary> {
    const name = (dto.name ?? '').trim();
    if (!name) throw new BadRequestException({ code: 'bad_request', message: 'name is required' });

    if (dto.files === undefined) {
      const skillId = await this.publishService.createUnpublished({
        tenantId: caller.tenantId,
        userId: caller.userId,
        name,
        displayName: dto.displayName?.trim() || null,
        createdByProjectId: caller.callingProjectId ?? null,
      });
      return this.findOne(caller, skillId);
    }

    const { skillId } = await this.publishService.create({
      tenantId: caller.tenantId,
      userId: caller.userId,
      name,
      displayName: dto.displayName ?? null,
      createdByProjectId: caller.callingProjectId ?? null,
      tree: readTree(dto.files),
      createdVia: 'form',
    });
    return this.findOne(caller, skillId);
  }

  async addVersion(caller: SkillCaller, skillId: string, dto: CreateSkillVersionDto): Promise<SkillSummary> {
    const skill = await this.assertEditable(caller, skillId);
    if (skill.disabled) throw disabledSkill(skill);

    await this.publishService.addVersion(skill, {
      tenantId: caller.tenantId,
      userId: caller.userId,
      tree: readTree(dto.files),
      createdVia: 'form',
    });
    return this.findOne(caller, skillId);
  }

  async import(caller: SkillCaller, archive: Buffer): Promise<SkillSummary> {
    const tree = await unpackSkill(archive).catch((error: unknown) => {
      if (error instanceof SkillArchiveError) {
        throw validationFailed([{ rule: error.rule, message: error.message, file: null, line: null }], []);
      }
      throw error;
    });

    const name = manifestName(tree);
    if (!name) {
      const gate = this.publishService.runGate(tree);
      throw validationFailed(gate.errors, gate.lints);
    }

    const sourceRef = manifestSourceRef(tree);
    const existing = await this.repository.findByName(caller.tenantId, name);
    if (!existing) {
      const { skillId } = await this.publishService.create({
        tenantId: caller.tenantId,
        userId: caller.userId,
        name,
        tree,
        createdVia: 'import',
        sourceRef,
      });
      return this.findOne(caller, skillId);
    }

    if (isServiceSkill(existing)) throw serviceSkillReadOnly(existing.name);
    if (!canEditSkill(existing, caller.userId)) throw nameUnavailable(name);
    if (existing.disabled) throw disabledSkill(existing);

    await this.publishService.addVersion(existing, {
      tenantId: caller.tenantId,
      userId: caller.userId,
      tree,
      createdVia: 'import',
      sourceRef,
    });
    return this.findOne(caller, existing.id);
  }

  async duplicate(caller: SkillCaller, skillId: string, dto: DuplicateSkillDto): Promise<SkillSummary> {
    const source = await assertSkillVisibleToUser(caller.tenantId, caller.userId, skillId);
    if (!source.latestVersionId) throw new NotFoundException(`Skill ${skillId} has no version to copy`);

    const name = (dto.name ?? '').trim();
    if (!name) throw new BadRequestException({ code: 'bad_request', message: 'name is required' });

    const tree = renameManifest(await this.repository.readTree(source.latestVersionId), name);
    const { skillId: created } = await this.publishService.create({
      tenantId: caller.tenantId,
      userId: caller.userId,
      name,
      displayName: dto.displayName ?? null,
      createdByProjectId: caller.callingProjectId ?? null,
      tree,
      createdVia: 'duplicate',
    });
    return this.findOne(caller, created);
  }

  async setVisibility(caller: SkillCaller, skillId: string, dto: SetSkillVisibilityDto): Promise<SkillSummary> {
    const skill = await this.assertEditable(caller, skillId);
    if (dto.visibility !== 'public') {
      throw visibilityIncoherent("Public skills can't be made private");
    }
    if (skill.visibility !== 'public') await this.repository.updateSkill(skillId, { visibility: 'public' });
    return this.findOne(caller, skillId);
  }

  async update(caller: SkillCaller, skillId: string, dto: UpdateSkillDto): Promise<SkillSummary> {
    await this.assertEditable(caller, skillId);
    if ('displayName' in dto) {
      const displayName = dto.displayName?.trim();
      await this.repository.updateSkill(skillId, { displayName: displayName ? displayName : null });
    }
    return this.findOne(caller, skillId);
  }

  async setDisabled(caller: SkillCaller, skillId: string, disabled: boolean): Promise<SkillSummary> {
    const skill = await this.assertDisableable(caller, skillId);
    if (disabled !== skill.disabled)
      await this.repository.setDisabledIn(caller.tenantId, skill.id, disabled, caller.userId);
    return this.findOne(caller, skillId);
  }

  async remove(
    caller: SkillCaller,
    skillId: string,
    removeProjects: (projectIds: string[]) => Promise<void>
  ): Promise<void> {
    const skill = await this.assertEditable(caller, skillId);

    const agents = await this.repository.agentsUsing(skillId);
    if (agents.length > 0) throw skillInUse(agents);

    if (!skill.disabled && skill.latestVersionId !== null) {
      throw new BadRequestException({
        code: 'skill_not_disabled',
        message: `Disable \`${skill.name}\` before deleting it`,
      });
    }

    if (skill.builderChatId) await removeProjects([skill.builderChatId]);
    await this.repository.deleteSkill(skillId);
  }

  private async availability(tenantId: string): Promise<Availability> {
    return { services: await this.serviceSkillAvailability.availableServiceIds(tenantId) };
  }

  private async assertDisableable(caller: SkillCaller, skillId: string): Promise<SkillRow> {
    const skill = await assertSkillVisibleToUser(caller.tenantId, caller.userId, skillId);
    if (isServiceSkill(skill)) throw serviceSkillReadOnly(skill.name);
    if (skill.origin === 'custom') return this.assertEditable(caller, skillId);
    if (!canDisableSkill(skill, caller.userId)) {
      throw notDisableable('The `platform` skill stays enabled: every agent carries it to know how the platform works');
    }
    if (!caller.canManageSkills) throw new MissingPermissionException(Perms.manageSkills);
    return skill;
  }

  private async assertEditable(caller: SkillCaller, skillId: string): Promise<SkillRow> {
    const skill = await assertSkillVisibleToUser(caller.tenantId, caller.userId, skillId);
    if (isServiceSkill(skill)) throw serviceSkillReadOnly(skill.name);
    if (!canEditSkill(skill, caller.userId)) {
      throw new ForbiddenException({ code: 'not_editable', message: `Skill \`${skill.name}\` cannot be edited` });
    }
    if (!isWithinCallingProject(skill, caller.callingProjectId)) {
      throw outsideCallingProject(`Skill \`${skill.name}\``);
    }
    return skill;
  }

  private async resolveVersion(caller: SkillCaller, skillId: string, version: number): Promise<SkillVersionRow> {
    await assertSkillVisibleToUser(caller.tenantId, caller.userId, skillId);
    return this.findVersionOrThrow(skillId, version);
  }

  private async findVersionOrThrow(skillId: string, version: number): Promise<SkillVersionRow> {
    if (!Number.isInteger(version) || version < 1) {
      throw new BadRequestException({ code: 'bad_request', message: 'version must be a positive integer' });
    }
    const row = await this.repository.findVersion(skillId, version);
    if (!row) throw new NotFoundException(`Version ${version} of skill ${skillId} not found`);
    return row;
  }
}

function agentLabel(agent: SkillAgentUsage): string {
  return agent.displayName ?? agent.name;
}

function disabledSkill(skill: SkillRow): BadRequestException {
  return new BadRequestException({
    code: 'skill_disabled',
    message: `Skill \`${skill.name}\` is disabled; enable it before publishing a new version`,
  });
}

function parseFilter(raw: string | undefined): SkillListFilter {
  if (!raw) return 'all';
  const found = CATALOG_LIST_FILTERS.find((filter) => filter === raw);
  if (!found) throw new BadRequestException({ code: 'bad_request', message: `Unknown filter \`${raw}\`` });
  return found;
}

function readTree(files: SkillFileInput[] | undefined): SkillTree {
  if (!Array.isArray(files)) throw new BadRequestException({ code: 'bad_request', message: 'files is required' });
  return files.map((file) => ({
    path: file.path ?? '',
    content: Buffer.from(file.content ?? '', file.isBinary ? 'base64' : 'utf8'),
    executable: file.executable === true,
  }));
}

function renameManifest(tree: SkillTree, name: string): SkillTree {
  return tree.map((file) => {
    if (file.path !== 'SKILL.md' || !isTextFile(file.content)) return file;
    const text = file.content.toString('utf8');
    return { ...file, content: Buffer.from(text.replace(/^name:.*$/m, `name: ${name}`), 'utf8') };
  });
}

function shippersOf(shippers: SkillShipper[], skillName: string): SkillShipper[] {
  return shippers.filter((agent) => agent.ships.has(skillName));
}

function availableAt(skill: SkillRow, availability: Availability): boolean {
  if (isServiceSkill(skill)) return availability.services.has(skill.externalServiceId);
  return !isRetiredSkill(skill);
}

function toSummary(
  row: SkillListRow,
  availability: Availability,
  shippers: SkillShipper[],
  userId: string
): SkillSummary {
  const { skill, latestVersion } = row;
  const shipping = skill.origin === 'built_in' ? shippersOf(shippers, skill.name).map((agent) => agent.id) : [];
  return {
    id: skill.id,
    name: skill.name,
    displayName: skill.displayName,
    description: skill.description,
    origin: skill.origin,
    visibility: skill.visibility,
    disabled: skill.disabled,
    disableable: canDisableSkill(skill, userId),
    available: availableAt(skill, availability),
    retired: isRetiredSkill(skill),
    createdBy: skill.createdBy,
    createdByName: row.createdByName,
    builderChatId: skill.builderChatId,
    externalServiceId: skill.externalServiceId,
    usedByAgentCount: new Set([...row.pinnedAgentIds, ...shipping]).size,
    outdatedAgentCount: row.outdatedAgentIds.filter((agentId) => !shipping.includes(agentId)).length,
    latestVersion: latestVersion
      ? { version: latestVersion.version, description: latestVersion.description, flags: latestVersion.flags }
      : null,
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
  };
}

function toVersionResponse(version: SkillVersionRow, skill: SkillRow): SkillVersionResponse {
  return {
    version: version.version,
    description: version.description,
    flags: version.flags,
    lints: version.lints,
    contentHash: version.contentHash,
    createdVia: version.createdVia,
    sourceRef: version.sourceRef,
    createdBy: version.createdBy,
    createdAt: version.createdAt,
    isLatest: skill.latestVersionId === version.id,
  };
}
