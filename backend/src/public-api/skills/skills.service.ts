import { Injectable } from '@nestjs/common';
import { Perms } from '../../permission/permission.constants';
import { SkillService, type SkillCaller } from '../../store/skill.service';
import { assertPermission, type Caller } from '../auth/caller';
import { mappingStoreErrors } from '../errors/store-error.mapper';
import { SkillMapper } from './skills.mapper';
import type {
  CreateSkill,
  CreateSkillVersion,
  DuplicateSkill,
  SkillDto,
  SkillFileListDto,
  SkillListDto,
  SkillListQuery,
  SkillValidationDto,
  UpdateSkill,
  ValidateSkill,
} from './skills.schema';

@Injectable()
export class PublicSkillsService {
  constructor(private readonly skills: SkillService) {}

  async list(caller: Caller, query: SkillListQuery): Promise<SkillListDto> {
    const rows = await mappingStoreErrors(() => this.skills.list(scopeOf(caller), query.filter, query.q));
    return { items: rows.map(SkillMapper.toDto) };
  }

  async findOne(caller: Caller, skillId: string): Promise<SkillDto> {
    return SkillMapper.toDto(await mappingStoreErrors(() => this.skills.findOne(scopeOf(caller), skillId)));
  }

  async listFiles(caller: Caller, skillId: string, version: number): Promise<SkillFileListDto> {
    const files = await mappingStoreErrors(() => this.skills.listFiles(scopeOf(caller), skillId, version));
    return { items: files.map(SkillMapper.toFileDto) };
  }

  validate(caller: Caller, body: ValidateSkill): SkillValidationDto {
    assertPermission(caller, Perms.manageSkills);
    return SkillMapper.toValidationDto(this.skills.validate({ name: body.name, files: body.files }));
  }

  async create(caller: Caller, body: CreateSkill): Promise<SkillDto> {
    assertPermission(caller, Perms.manageSkills);
    return SkillMapper.toDto(await mappingStoreErrors(() => this.skills.create(scopeOf(caller), body)));
  }

  async addVersion(caller: Caller, skillId: string, body: CreateSkillVersion): Promise<SkillDto> {
    const scope = await this.scopeAfterVisibleRead(caller, skillId);
    return SkillMapper.toDto(await mappingStoreErrors(() => this.skills.addVersion(scope, skillId, body)));
  }

  async update(caller: Caller, skillId: string, body: UpdateSkill): Promise<SkillDto> {
    const scope = await this.scopeAfterVisibleRead(caller, skillId);
    return SkillMapper.toDto(await mappingStoreErrors(() => this.skills.update(scope, skillId, body)));
  }

  async duplicate(caller: Caller, skillId: string, body: DuplicateSkill): Promise<SkillDto> {
    const scope = await this.scopeAfterVisibleRead(caller, skillId);
    return SkillMapper.toDto(await mappingStoreErrors(() => this.skills.duplicate(scope, skillId, body)));
  }

  private async scopeAfterVisibleRead(caller: Caller, skillId: string): Promise<SkillCaller> {
    const scope = scopeOf(caller);
    await mappingStoreErrors(() => this.skills.findOne(scope, skillId));
    assertPermission(caller, Perms.manageSkills);
    return scope;
  }
}

function scopeOf(caller: Caller): SkillCaller {
  return {
    tenantId: caller.organization.id,
    userId: caller.user.platformId,
    canManageSkills: caller.permissions.has(Perms.manageSkills),
  };
}
