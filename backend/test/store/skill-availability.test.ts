import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { SkillAvailability } from '../../src/store/skill-availability';
import { reservedSkillNames } from '../../src/store/skill-reconciler.service';

function offeredBy(agentPrivileged: boolean): SkillAvailability {
  return new SkillAvailability(new ConfigService({ agentPrivileged }));
}

const APP_BUILDING_PACKAGES = ['app-builder', 'makara-app-builder'];
const OTHER_PACKAGES = ['skill-agent-builder', 'external-service-builder', 'custom'];

describe('the shipped agent-config on a deployment without privileged agent pods', () => {
  const availability = offeredBy(false);

  it('offers every Built-in Skill except docker', () => {
    const offered = availability.composedSkills().map((skill) => skill.name);

    expect(availability.unofferedSkills()).toEqual(['docker']);
    expect(offered).not.toContain('docker');
    expect(offered).toContain('platform');
  });

  it.each([...APP_BUILDING_PACKAGES, ...OTHER_PACKAGES])('leaves docker out of the %s package', (packageName) => {
    expect(availability.packageSkillNames(packageName).has('docker')).toBe(false);
    expect(availability.readPackageSkill(packageName, 'docker')).toBeNull();
  });

  it('still reserves the docker name against Custom Skills', () => {
    expect(reservedSkillNames().has('docker')).toBe(true);
  });
});

describe('the shipped agent-config on a deployment with privileged agent pods', () => {
  const availability = offeredBy(true);

  it('offers every Built-in Skill', () => {
    expect(availability.unofferedSkills()).toEqual([]);
    expect(availability.composedSkills().map((skill) => skill.name)).toContain('docker');
  });

  it.each(APP_BUILDING_PACKAGES)('lays docker into the %s package', (packageName) => {
    expect(availability.packageSkillNames(packageName).has('docker')).toBe(true);
    expect(availability.readPackageSkill(packageName, 'docker')?.name).toBe('docker');
  });

  it.each(OTHER_PACKAGES)('still leaves docker out of the %s package', (packageName) => {
    expect(availability.packageSkillNames(packageName).has('docker')).toBe(false);
  });
});
