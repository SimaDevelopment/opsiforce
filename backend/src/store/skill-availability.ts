import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  packageSkillNames,
  privilegedOnlySkillNames,
  readComposedSkills,
  readPackageSkill,
  type ComposedSkill,
} from './skill-tree';

@Injectable()
export class SkillAvailability {
  constructor(private readonly configService: ConfigService) {}

  unofferedSkills(): string[] {
    return this.configService.get<boolean>('agentPrivileged', false) ? [] : privilegedOnlySkillNames();
  }

  composedSkills(): ComposedSkill[] {
    const unoffered = new Set(this.unofferedSkills());
    return readComposedSkills().filter((skill) => !unoffered.has(skill.name));
  }

  packageSkillNames(packageName: string): Set<string> {
    const unoffered = new Set(this.unofferedSkills());
    return new Set([...packageSkillNames(packageName)].filter((name) => !unoffered.has(name)));
  }

  readPackageSkill(packageName: string, name: string): ComposedSkill | null {
    return this.packageSkillNames(packageName).has(name) ? readPackageSkill(packageName, name) : null;
  }

  ownedSkillDrift(packageName: string, owned: ReadonlySet<string>): { unoffered: string[]; missing: string[] } {
    const offered = this.packageSkillNames(packageName);
    return {
      unoffered: this.unofferedSkills().filter((name) => owned.has(name)),
      missing: privilegedOnlySkillNames().filter((name) => offered.has(name) && !owned.has(name)),
    };
  }
}
