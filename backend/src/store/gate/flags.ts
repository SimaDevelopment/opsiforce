import { type SkillFlags, type SkillTree } from './skill-tree';

export function computeFlags(tree: SkillTree): SkillFlags {
  let hasExecutables = false;

  for (const file of tree) {
    if (file.executable || file.path.startsWith('scripts/')) hasExecutables = true;
  }

  return { has_executables: hasExecutables };
}
