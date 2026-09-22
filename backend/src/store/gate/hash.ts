import { createHash } from 'node:crypto';
import { fileMode, type SkillTree } from './skill-tree';

export function hashSkillTree(tree: SkillTree): string {
  const hash = createHash('sha256');
  const sorted = [...tree].toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const file of sorted) {
    hash.update(`${file.path}\0${fileMode(file)}\0`);
    hash.update(file.content);
  }
  return hash.digest('hex');
}
