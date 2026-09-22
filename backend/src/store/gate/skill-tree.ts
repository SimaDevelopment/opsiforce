export type SkillFile = {
  path: string;
  content: Buffer;
  executable: boolean;
  symlink?: boolean;
};

export type SkillTree = SkillFile[];

export type GateFinding = {
  rule: string;
  message: string;
  file: string | null;
  line: number | null;
};

export type SkillFlags = {
  has_executables: boolean;
};

export type GateResult = {
  errors: GateFinding[];
  lints: GateFinding[];
  flags: SkillFlags;
  normalizedTree: SkillTree;
};

export type ValidateSkillTreeOptions = {
  expectedName?: string;
  reservedNames?: readonly string[];
};

export const SKILL_MANIFEST_PATH = 'SKILL.md';
export const MAX_TREE_BYTES = 5 * 1024 * 1024;
export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_FILE_COUNT = 200;
export const ALLOWED_FRONTMATTER_KEYS = ['name', 'description', 'license', 'metadata', 'allowed-tools'] as const;

export function isTextFile(content: Buffer): boolean {
  const window = content.subarray(0, 8192);
  return !window.includes(0);
}

export function decodeText(content: Buffer): string {
  return content.toString('utf8');
}

export function fileMode(file: SkillFile): string {
  return file.executable ? '100755' : '100644';
}

export function lineIndex(text: string): (index: number) => number {
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return (index) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (starts[middle] <= index) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
}
