import { createHash } from 'node:crypto';
import { fileMode, type SkillFile, type SkillTree } from './skill-tree';

export function compareSkillPaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export class SkillTreeHasher {
  private readonly hash = createHash('sha256');

  add(file: SkillFile): void {
    this.hash.update(`${file.path}\0${fileMode(file)}\0`);
    this.hash.update(file.content);
  }

  digest(): string {
    return this.hash.digest('hex');
  }
}

export function hashSkillTree(tree: SkillTree): string {
  const hasher = new SkillTreeHasher();
  for (const file of [...tree].toSorted((a, b) => compareSkillPaths(a.path, b.path))) hasher.add(file);
  return hasher.digest();
}
