import { Injectable } from '@nestjs/common';
import { PLATFORM_SKILL_NAME } from '../agent/agent.types';
import { SkillRepository } from '../store/skill.repository';
import { packageSkillNames, readPackageSkill } from '../store/skill-tree';
import { DeliveryRepository, type DeliveryTarget } from './delivery.repository';
import { DeliveryService } from './delivery.service';
import { CUSTOM_AGENT_PACKAGE, type DeliverySkill } from './delivery.types';
import { SERVICE_SKILL_PREFIX } from './service-skill-source';
import { SkillDeliveryRepository } from './skill-delivery.repository';
import { SkillDeliveryService } from './skill-delivery.service';
import { SkillSwitchRepository } from './skill-switch.repository';
import { WorkspaceWriter } from './workspace-writer';

export type EnvironmentSkillKind = 'store' | 'package' | 'service' | 'platform';

export type EnvironmentSkillState = 'on' | 'switched-off' | 'switching-on' | 'retrying' | 'always-on';

export interface EnvironmentSkill {
  name: string;
  kind: EnvironmentSkillKind;
  description: string | null;
  state: EnvironmentSkillState;
  service: string | null;
  carried: boolean;
}

export interface EnvironmentSkills {
  agentName: string;
  skills: EnvironmentSkill[];
}

export type SkillsOffCarryLine = {
  kind: 'skills-off';
  switchedOff: string[];
  switchedOn: string[];
};

export class EnvironmentSkillNotFound extends Error {
  constructor(readonly skillName: string) {
    super(`No Skill ${skillName} in this environment`);
  }
}

export class PlatformSkillAlwaysOn extends Error {
  constructor() {
    super('The platform Skill is always on');
  }
}

export class SkillNoLongerCarried extends Error {
  constructor(readonly skillName: string) {
    super(`The Agent no longer carries ${skillName}, so it cannot be switched back on here`);
  }
}

export class AgentUpdateInProgress extends Error {
  constructor() {
    super('An Agent Update is running in this environment; try again in a minute');
  }
}

interface CarriedSkill {
  name: string;
  kind: EnvironmentSkillKind;
  description: string | null;
  lay: () => Promise<{ skill: DeliverySkill; recordDelivery: boolean } | 'fan-out'>;
}

@Injectable()
export class EnvironmentSkillsService {
  private readonly packageDescriptions = new Map<string, string | null>();

  constructor(
    private readonly delivery: DeliveryService,
    private readonly deliveries: DeliveryRepository,
    private readonly fanOut: SkillDeliveryRepository,
    private readonly skillDeliveries: SkillDeliveryService,
    private readonly switches: SkillSwitchRepository,
    private readonly writer: WorkspaceWriter,
    private readonly skills: SkillRepository
  ) {}

  async list(projectEnvironmentId: string): Promise<EnvironmentSkills> {
    const { target, carried } = await this.carried(projectEnvironmentId);
    const switchedOff = await this.switches.switchedOffNames(projectEnvironmentId);
    const onDisk = new Set(await this.writer.listSkillNames(target.directory));
    const state = await this.fanOut.state(projectEnvironmentId);
    const failing = new Set(state?.failedAt ? state.pendingSkills : []);

    const stateOf = (name: string): EnvironmentSkillState => {
      if (name === PLATFORM_SKILL_NAME) return 'always-on';
      if (switchedOff.has(name)) return 'switched-off';
      if (failing.has(name)) return 'retrying';
      return onDisk.has(name) ? 'on' : 'switching-on';
    };

    const listed: EnvironmentSkill[] = [...carried.values()].map((skill) => ({
      name: skill.name,
      kind: skill.kind,
      description: skill.description,
      state: stateOf(skill.name),
      service: serviceSlugOf(skill),
      carried: true,
    }));
    for (const name of onDisk) {
      if (carried.has(name)) continue;
      listed.push({
        name,
        kind: name.startsWith(SERVICE_SKILL_PREFIX) ? 'service' : 'store',
        description: null,
        state: stateOf(name),
        service: name.startsWith(SERVICE_SKILL_PREFIX) ? name.slice(SERVICE_SKILL_PREFIX.length) : null,
        carried: false,
      });
    }
    return { agentName: target.agentName, skills: listed.toSorted(byKindThenName) };
  }

  async find(projectEnvironmentId: string, name: string): Promise<EnvironmentSkill> {
    const skill = (await this.list(projectEnvironmentId)).skills.find((candidate) => candidate.name === name);
    if (skill) return skill;
    if ((await this.switches.switchedOffNames(projectEnvironmentId)).has(name)) throw new SkillNoLongerCarried(name);
    throw new EnvironmentSkillNotFound(name);
  }

  async switchOff(projectEnvironmentId: string, name: string, switchedOffBy: string | null): Promise<void> {
    const skill = await this.find(projectEnvironmentId, name);
    if (skill.kind === 'platform') throw new PlatformSkillAlwaysOn();
    await this.switches.switchOff(projectEnvironmentId, name, switchedOffBy);
    await this.skillDeliveries.enqueueEnvironments([projectEnvironmentId]);
  }

  async switchOn(projectEnvironmentId: string, name: string): Promise<void> {
    const { carried } = await this.carried(projectEnvironmentId);
    const skill = carried.get(name);
    if (!skill) {
      if ((await this.switches.switchedOffNames(projectEnvironmentId)).has(name)) throw new SkillNoLongerCarried(name);
      throw new EnvironmentSkillNotFound(name);
    }
    if (!(await this.switches.switchedOffNames(projectEnvironmentId)).has(name)) return;
    const lay = await skill.lay();
    if (lay !== 'fan-out' && (await this.skillDeliveries.hasRunningAgentUpdate(projectEnvironmentId))) {
      throw new AgentUpdateInProgress();
    }
    await this.switches.switchOn(projectEnvironmentId, name);
    if (lay === 'fan-out') {
      await this.skillDeliveries.enqueueEnvironments([projectEnvironmentId]);
      return;
    }
    await this.skillDeliveries.layNow(projectEnvironmentId, lay.skill, { recordDelivery: lay.recordDelivery });
  }

  async carry(sourceProjectEnvironmentId: string, targetProjectEnvironmentId: string): Promise<SkillsOffCarryLine[]> {
    if (sourceProjectEnvironmentId === targetProjectEnvironmentId) return [];
    const change = await this.switches.replace(sourceProjectEnvironmentId, targetProjectEnvironmentId);
    if (change.switchedOff.length === 0 && change.switchedOn.length === 0) return [];
    await this.skillDeliveries.enqueueEnvironments([targetProjectEnvironmentId]);
    return [{ kind: 'skills-off', ...change }];
  }

  private async carried(
    projectEnvironmentId: string
  ): Promise<{ target: DeliveryTarget; carried: Map<string, CarriedSkill> }> {
    const { target, pinned } = await this.delivery.pinnedSkillsFor(projectEnvironmentId);
    const builtIn = target.agentOrigin === 'built_in';
    const packageName = builtIn ? target.agentName : CUSTOM_AGENT_PACKAGE;
    const carried = new Map<string, CarriedSkill>();

    for (const name of packageSkillNames(packageName)) {
      carried.set(name, {
        name,
        kind: name === PLATFORM_SKILL_NAME ? 'platform' : 'package',
        description: this.packageSkillDescription(packageName, name),
        lay: async () => {
          const shipped = readPackageSkill(packageName, name);
          if (!shipped) throw new EnvironmentSkillNotFound(name);
          return {
            skill: { name, skillVersionId: null, contentHash: shipped.contentHash, tree: shipped.tree },
            recordDelivery: false,
          };
        },
      });
    }

    const received = builtIn ? null : await this.receivedNames(projectEnvironmentId, target.directory);
    for (const skill of pinned) {
      if (builtIn && carried.has(skill.name)) continue;
      if (received && !received.has(skill.name)) continue;
      carried.set(skill.name, {
        name: skill.name,
        kind: 'store',
        description: skill.description,
        lay: async () =>
          builtIn
            ? 'fan-out'
            : {
                skill: {
                  name: skill.name,
                  skillVersionId: skill.skillVersionId,
                  contentHash: skill.contentHash,
                  tree: await this.skills.readTree(skill.skillVersionId),
                },
                recordDelivery: true,
              },
      });
    }

    for (const skill of await this.delivery.serviceSkillsFor(projectEnvironmentId)) {
      if (carried.has(skill.name)) continue;
      carried.set(skill.name, {
        name: skill.name,
        kind: 'service',
        description: skill.description,
        lay: () => Promise.resolve('fan-out'),
      });
    }
    return { target, carried };
  }

  /** The image's packages do not change while the backend runs, so each description is read once. */
  private packageSkillDescription(packageName: string, name: string): string | null {
    const key = `${packageName}/${name}`;
    if (!this.packageDescriptions.has(key)) {
      this.packageDescriptions.set(key, readPackageSkill(packageName, name)?.description ?? null);
    }
    return this.packageDescriptions.get(key) ?? null;
  }

  private async receivedNames(projectEnvironmentId: string, directory: string): Promise<Set<string>> {
    const [delivered, onDisk, switchedOff] = await Promise.all([
      this.deliveries.delivered(projectEnvironmentId),
      this.writer.listSkillNames(directory),
      this.switches.switchedOffNames(projectEnvironmentId),
    ]);
    return new Set([...delivered.map((row) => row.skillName), ...onDisk, ...switchedOff]);
  }
}

const KIND_ORDER: EnvironmentSkillKind[] = ['store', 'package', 'service', 'platform'];

function byKindThenName(a: EnvironmentSkill, b: EnvironmentSkill): number {
  return KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.name.localeCompare(b.name);
}

function serviceSlugOf(skill: CarriedSkill): string | null {
  return skill.kind === 'service' ? skill.name.slice(SERVICE_SKILL_PREFIX.length) : null;
}
