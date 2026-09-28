import type { SkillTree } from './skill-tree';
import { validateSkillTree } from './validate';

const KEY_LIKE_RULE = 'secret_detected';

export interface KeyLikeHit {
  path: string;
  reason: string;
}

/** The gate's secret findings over a tree, as warnings rather than refusals. */
export function scanKeyLike(tree: SkillTree): KeyLikeHit[] {
  return tree.flatMap(({ path, content }) =>
    validateSkillTree([{ path, content, executable: false }])
      .errors.filter((finding) => finding.rule === KEY_LIKE_RULE)
      .map((finding) => ({ path, reason: `line ${finding.line} ${finding.message}` }))
  );
}
