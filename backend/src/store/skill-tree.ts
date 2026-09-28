import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { PLATFORM_SKILL_NAME } from '../agent/agent.types';
import { CUSTOM_AGENT_PACKAGE } from '../delivery/delivery.types';
import { computeFlags, hashSkillTree, SKILL_MANIFEST_PATH, type SkillFlags, type SkillTree } from './gate';
import { parseFrontmatter } from './gate/frontmatter';
import { decodeText } from './gate/skill-tree';

export interface ComposedSkill {
  name: string;
  tree: SkillTree;
  contentHash: string;
  description: string | null;
  flags: SkillFlags;
}

export function agentConfigRoot(): string {
  return join(process.cwd(), '..', 'agent-config');
}

export function skillSourceDirectories(root: string = agentConfigRoot()): string[] {
  return [...agentSkillDirectories(root), ...agentSkillDirectories(join(root, 'private'))];
}

function agentSkillDirectories(root: string): string[] {
  const shared = join(root, 'skills');
  const overrides = subdirectories(join(root, 'agents')).map((agent) => join(root, 'agents', agent, 'skills'));
  return [shared, ...overrides];
}

function subdirectories(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .toSorted((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

interface PackageSkillsFile {
  customPackageSharedSkills: string[];
  sharedSkillExclusions: Record<string, string[]>;
}

/** The set `agent-config/scripts/compose-skills.mjs` lays into the package in the agent image. */
export function packageSkillNames(packageName: string, root: string = agentConfigRoot()): Set<string> {
  const rules = JSON.parse(readFileSync(join(root, 'package-skills.json'), 'utf8')) as PackageSkillsFile;
  const shared = subdirectories(join(root, 'skills'));
  const excluded = rules.sharedSkillExclusions[packageName] ?? [];
  const sharedShipped =
    packageName === CUSTOM_AGENT_PACKAGE
      ? shared.filter((name) => rules.customPackageSharedSkills.includes(name))
      : shared.filter((name) => !excluded.includes(name));
  const own = [join(root, 'agents', packageName, 'skills'), join(root, 'private', 'agents', packageName, 'skills')];
  return new Set([...sharedShipped, ...own.flatMap((directory) => subdirectories(directory))]);
}

export function assertBuiltInSkillsShipped(root: string = agentConfigRoot()): void {
  const names = new Set(skillSourceDirectories(root).flatMap((directory) => subdirectories(directory)));
  if (!names.has(PLATFORM_SKILL_NAME)) {
    throw new Error(
      `No built-in Skill tree at ${root}; the backend image must ship agent-config/skills and agent-config/agents/*/skills`
    );
  }
}

export function readComposedSkills(root: string = agentConfigRoot()): ComposedSkill[] {
  const byName = new Map<string, string>();
  for (const directory of skillSourceDirectories(root)) {
    for (const name of subdirectories(directory)) {
      byName.set(name, join(directory, name));
    }
  }
  return [...byName.entries()]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([name, directory]) => readSkill(name, directory));
}

export function readSkill(name: string, directory: string): ComposedSkill {
  const tree = readSkillTree(directory);
  return {
    name,
    tree,
    contentHash: hashSkillTree(tree),
    description: manifestDescription(tree),
    flags: computeFlags(tree),
  };
}

export function readSkillTree(directory: string): SkillTree {
  return walk(directory, '').toSorted((a, b) => a.path.localeCompare(b.path));
}

function walk(directory: string, prefix: string): SkillTree {
  const found: SkillTree = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    const path = prefix ? posix.join(prefix, entry.name) : entry.name;
    if (entry.isSymbolicLink()) {
      found.push({ path, content: Buffer.alloc(0), executable: false, symlink: true });
      continue;
    }
    if (entry.isDirectory()) {
      found.push(...walk(absolute, path));
      continue;
    }
    found.push({ path, content: readFileSync(absolute), executable: (lstatSync(absolute).mode & 0o111) !== 0 });
  }
  return found;
}

export function manifestDescription(tree: SkillTree): string | null {
  const manifest = tree.find((file) => file.path === SKILL_MANIFEST_PATH);
  if (!manifest) return null;
  const description = parseFrontmatter(decodeText(manifest.content)).entries.findLast(
    (entry) => entry.key === 'description'
  );
  return description?.value.trim() || null;
}
