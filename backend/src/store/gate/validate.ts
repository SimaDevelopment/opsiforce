import { computeFlags } from './flags';
import { parseFrontmatter, splitLines, type FrontmatterEntry } from './frontmatter';
import {
  ALLOWED_FRONTMATTER_KEYS,
  MAX_FILE_BYTES,
  MAX_FILE_COUNT,
  MAX_TREE_BYTES,
  SKILL_MANIFEST_PATH,
  decodeText,
  isTextFile,
  lineIndex,
  type GateFinding,
  type GateResult,
  type SkillFile,
  type SkillTree,
  type ValidateSkillTreeOptions,
} from './skill-tree';

const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const MAX_BODY_LINES = 500;
const MIN_DESCRIPTION_WORDS = 20;
const MAX_LINK_DEPTH = 3;

const INVISIBLE_CHARACTERS = /[​-‏‪-‮⁠-⁤﻿\u{E0000}-\u{E007F}]/gu;

const SECRET_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: 'aws-access-key-id', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { label: 'github-token', pattern: /\bgh[pos]_[A-Za-z0-9]{36,}\b/g },
  { label: 'slack-token', pattern: /\bxox[bpas]-[A-Za-z0-9-]{10,}/g },
  { label: 'private-key-block', pattern: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g },
];

const MARKDOWN_LINK = /\[[^\]]*\]\(([^)\s]+)\)/g;
const BARE_REFERENCE = /(?:^|[\s`("'])((?:\.\/)?(?:references|scripts|assets)\/[^\s`)<>"',;]+)/gm;

export function validateSkillTree(tree: SkillTree, options: ValidateSkillTreeOptions = {}): GateResult {
  const errors: GateFinding[] = [];
  const lints: GateFinding[] = [];

  collectStructureErrors(tree, errors);
  collectContentErrors(tree, errors);

  const manifest = tree.find((file) => file.path === SKILL_MANIFEST_PATH);
  if (!manifest) {
    errors.push(finding('skill_md_missing', `${SKILL_MANIFEST_PATH} is missing at the skill root`, null, null));
    return { errors, lints, flags: computeFlags(tree), normalizedTree: tree };
  }

  const text = decodeText(manifest.content);
  const parsed = parseFrontmatter(text);
  if (!parsed.present) {
    errors.push(
      finding('frontmatter_missing', 'SKILL.md does not start with a YAML frontmatter block', SKILL_MANIFEST_PATH, 1)
    );
    return { errors, lints, flags: computeFlags(tree), normalizedTree: tree };
  }
  if (parsed.malformed) {
    errors.push(
      finding('frontmatter_unparsable', 'the YAML frontmatter block could not be parsed', SKILL_MANIFEST_PATH, 1)
    );
  }

  const byKey = new Map<string, FrontmatterEntry>();
  for (const entry of parsed.entries) byKey.set(entry.key, entry);

  collectFrontmatterErrors(parsed.entries, byKey, options, errors);
  collectLints(tree, text, parsed.bodyStartLine, byKey, lints);

  const allowedTools = byKey.get('allowed-tools');
  const normalizedTree = allowedTools ? stripFrontmatterEntry(tree, manifest, text, allowedTools) : tree;

  return { errors, lints, flags: computeFlags(tree), normalizedTree };
}

function collectStructureErrors(tree: SkillTree, errors: GateFinding[]): void {
  if (tree.length > MAX_FILE_COUNT) {
    errors.push(
      finding('file_count', `the skill holds ${tree.length} files, more than the ${MAX_FILE_COUNT} allowed`, null, null)
    );
  }

  const seenPaths = new Set<string>();
  let total = 0;
  for (const file of tree) {
    total += file.content.length;
    if (seenPaths.has(file.path)) {
      errors.push(finding('duplicate_path', 'the tree holds more than one entry for this path', file.path, null));
    }
    seenPaths.add(file.path);
    if (file.symlink) {
      errors.push(finding('symlink_entry', 'symlinks are not allowed in a skill', file.path, null));
    }
    const problem = pathProblem(file.path);
    if (problem) {
      errors.push(finding('path_traversal', `unsafe path (${problem})`, file.path, null));
    }
    if (file.content.length > MAX_FILE_BYTES) {
      errors.push(
        finding(
          'size_file',
          `${file.content.length} bytes exceeds the ${MAX_FILE_BYTES} byte per-file limit`,
          file.path,
          null
        )
      );
    }
  }

  if (total > MAX_TREE_BYTES) {
    errors.push(
      finding('size_total', `${total} bytes exceeds the ${MAX_TREE_BYTES} byte limit for a skill`, null, null)
    );
  }
}

function collectContentErrors(tree: SkillTree, errors: GateFinding[]): void {
  for (const file of tree) {
    if (!isTextFile(file.content)) continue;
    const text = decodeText(file.content);

    const lineAt = lineIndex(text);

    INVISIBLE_CHARACTERS.lastIndex = 0;
    const invisible = INVISIBLE_CHARACTERS.exec(text);
    if (invisible) {
      const codePoint = invisible[0].codePointAt(0) ?? 0;
      errors.push(
        finding(
          'invisible_unicode',
          `invisible or bidirectional character U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`,
          file.path,
          lineAt(invisible.index)
        )
      );
    }

    const seen = new Set<string>();
    for (const { label, pattern } of SECRET_PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        const line = lineAt(match.index ?? 0);
        const key = `${label}:${line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        errors.push(finding('secret_detected', `looks like a ${label}`, file.path, line));
      }
    }
  }
}

function collectFrontmatterErrors(
  entries: FrontmatterEntry[],
  byKey: Map<string, FrontmatterEntry>,
  options: ValidateSkillTreeOptions,
  errors: GateFinding[]
): void {
  const allowed = new Set<string>(ALLOWED_FRONTMATTER_KEYS);
  const seenKeys = new Set<string>();
  for (const entry of entries) {
    if (seenKeys.has(entry.key)) {
      errors.push(
        finding(
          'frontmatter_duplicate_key',
          `\`${entry.key}\` appears more than once in the frontmatter`,
          SKILL_MANIFEST_PATH,
          entry.line
        )
      );
    }
    seenKeys.add(entry.key);
    if (!allowed.has(entry.key)) {
      errors.push(
        finding(
          'frontmatter_unknown_key',
          `\`${entry.key}\` is not an allowed frontmatter key`,
          SKILL_MANIFEST_PATH,
          entry.line
        )
      );
    }
  }

  const name = byKey.get('name');
  if (!name || name.value.length === 0) {
    errors.push(
      finding('name_missing', '`name` is missing from the frontmatter', SKILL_MANIFEST_PATH, name?.line ?? 1)
    );
  } else {
    if (name.value.length > MAX_NAME_LENGTH) {
      errors.push(
        finding(
          'name_length',
          `\`name\` is ${name.value.length} characters, over the ${MAX_NAME_LENGTH} allowed`,
          SKILL_MANIFEST_PATH,
          name.line
        )
      );
    }
    if (!NAME_PATTERN.test(name.value)) {
      errors.push(finding('name_format', '`name` must be lowercase kebab-case', SKILL_MANIFEST_PATH, name.line));
    }
    if (options.expectedName !== undefined && name.value !== options.expectedName) {
      errors.push(
        finding(
          'name_mismatch',
          `\`name\` is \`${name.value}\` but the skill is \`${options.expectedName}\``,
          SKILL_MANIFEST_PATH,
          name.line
        )
      );
    }
    if (options.reservedNames?.includes(name.value)) {
      errors.push(finding('name_reserved', `\`${name.value}\` is unavailable`, SKILL_MANIFEST_PATH, name.line));
    }
  }

  const description = byKey.get('description');
  if (!description || description.value.length === 0) {
    errors.push(
      finding(
        'description_missing',
        '`description` is missing from the frontmatter',
        SKILL_MANIFEST_PATH,
        description?.line ?? 1
      )
    );
    return;
  }
  if (description.value.length > MAX_DESCRIPTION_LENGTH) {
    errors.push(
      finding(
        'description_length',
        `\`description\` is ${description.value.length} characters, over the ${MAX_DESCRIPTION_LENGTH} allowed`,
        SKILL_MANIFEST_PATH,
        description.line
      )
    );
  }
  if (description.value.includes('<') || description.value.includes('>')) {
    errors.push(
      finding(
        'description_angle_brackets',
        '`description` must not contain `<` or `>`',
        SKILL_MANIFEST_PATH,
        description.line
      )
    );
  }
}

function collectLints(
  tree: SkillTree,
  text: string,
  bodyStartLine: number,
  byKey: Map<string, FrontmatterEntry>,
  lints: GateFinding[]
): void {
  const lines = splitLines(text);
  const bodyLines = Math.max(0, lines.length - (bodyStartLine - 1));
  if (bodyLines > MAX_BODY_LINES) {
    lints.push(
      finding(
        'body_too_long',
        `the SKILL.md body is ${bodyLines} lines, over the ${MAX_BODY_LINES} recommended`,
        SKILL_MANIFEST_PATH,
        bodyStartLine
      )
    );
  }

  const description = byKey.get('description');
  if (description) {
    const words = description.value.split(/\s+/).filter((word) => word.length > 0).length;
    if (words < MIN_DESCRIPTION_WORDS) {
      lints.push(
        finding(
          'description_too_short',
          `\`description\` is ${words} words; under ${MIN_DESCRIPTION_WORDS} rarely tells the model when to load the skill`,
          SKILL_MANIFEST_PATH,
          description.line
        )
      );
    }
  }

  const allowedTools = byKey.get('allowed-tools');
  if (allowedTools) {
    lints.push(
      finding(
        'allowed_tools_present',
        '`allowed-tools` is platform-owned and has been stripped',
        SKILL_MANIFEST_PATH,
        allowedTools.line
      )
    );
  }

  const paths = new Set(tree.map((file) => file.path));
  for (const reference of collectReferences(text)) {
    if (reference.target.split('/').length - 1 > MAX_LINK_DEPTH) {
      lints.push(
        finding(
          'link_too_deep',
          `\`${reference.target}\` nests deeper than ${MAX_LINK_DEPTH} directories`,
          SKILL_MANIFEST_PATH,
          reference.line
        )
      );
      continue;
    }
    const resolves = paths.has(reference.target) || [...paths].some((path) => path.startsWith(`${reference.target}/`));
    if (!resolves) {
      lints.push(
        finding(
          'link_unresolved',
          `\`${reference.target}\` does not resolve inside the skill`,
          SKILL_MANIFEST_PATH,
          reference.line
        )
      );
    }
  }
}

function collectReferences(text: string): { target: string; line: number }[] {
  const found = new Map<string, { target: string; line: number }>();
  const lineAt = lineIndex(text);
  for (const pattern of [MARKDOWN_LINK, BARE_REFERENCE]) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const target = normalizeReference(match[1]);
      if (!target) continue;
      const line = lineAt(match.index ?? 0);
      const key = `${target}:${line}`;
      if (!found.has(key)) found.set(key, { target, line });
    }
  }
  return [...found.values()];
}

function normalizeReference(raw: string): string | null {
  if (raw.includes('://') || raw.startsWith('#') || raw.startsWith('/')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;
  const withoutFragment = raw.split('#')[0].split('?')[0];
  const target = withoutFragment.replace(/^\.\//, '').replace(/\/$/, '');
  if (target.length === 0 || !target.includes('/')) return null;
  return target;
}

function stripFrontmatterEntry(tree: SkillTree, manifest: SkillFile, text: string, entry: FrontmatterEntry): SkillTree {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const kept = splitLines(text).filter((_, index) => index + 1 < entry.line || index + 1 > entry.endLine);
  const stripped: SkillFile = { ...manifest, content: Buffer.from(kept.join(eol), 'utf8') };
  return tree.map((file) => (file === manifest ? stripped : file));
}

function pathProblem(path: string): string | null {
  if (path.length === 0) return 'the path is empty';
  if (path.startsWith('/')) return 'absolute';
  if (path.includes('\\')) return 'contains a backslash';
  const segments = path.split('/');
  if (segments.includes('..')) return "contains a '..' segment";
  if (segments.some((segment) => segment.length === 0)) return 'contains an empty segment';
  return null;
}

function finding(rule: string, message: string, file: string | null, line: number | null): GateFinding {
  return { rule, message, file, line };
}
