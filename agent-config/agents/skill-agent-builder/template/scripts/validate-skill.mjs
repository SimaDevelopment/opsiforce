/**
 * GENERATED FILE — do not edit.
 *
 * The offline copy of the platform's skill validation gate, so the authoring loop sees the same
 * ERRORS and LINTS the API would answer without spending a round trip. Regenerate with:
 *
 *   node agent-config/scripts/generate-validate-skill.mjs
 *
 * Sources, with the sha256 the copy was cut from (the drift test recomputes these):
 *   backend/src/store/gate/skill-tree.ts  02fd7ca849f6c60e8a0ddc4ed0b1aaf0679a565e242a736bd080b3182708bf62
 *   backend/src/store/gate/frontmatter.ts  2f6ef70391a6499c1572c1f271c13f28b26b8e7a3fd645704b3c10b6542fc1c8
 *   backend/src/store/gate/flags.ts  639df97b25ed264b50802e49aa08bff115d9ff7775429ddd3869d662ef38cfcf
 *   backend/src/store/gate/validate.ts  2b9e5cd2f1c2dddd4a4062cb89e555afd65677189bae9974d4f79db5bb6d74d6
 */

import { lstatSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

const SKILL_MANIFEST_PATH = 'SKILL.md';
const MAX_TREE_BYTES = 5 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILE_COUNT = 200;
const ALLOWED_FRONTMATTER_KEYS = ['name', 'description', 'license', 'metadata', 'allowed-tools']         ;

function isTextFile(content        )          {
  const window = content.subarray(0, 8192);
  return !window.includes(0);
}

function decodeText(content        )         {
  return content.toString('utf8');
}

function fileMode(file           )         {
  return file.executable ? '100755' : '100644';
}

function lineIndex(text        )                            {
  const starts           = [0];
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

const KEY_LINE = /^([A-Za-z0-9_][A-Za-z0-9_.-]*):(?:[ \t]+(.*))?$/;

function splitLines(text        )           {
  return text.split(/\r?\n/);
}

function parseFrontmatter(text        )                    {
  const lines = splitLines(text);
  const empty                    = {
    present: false,
    malformed: false,
    entries: [],
    closingLine: 0,
    bodyStartLine: 1,
  };
  if (lines.length === 0 || lines[0].trimEnd() !== '---') return empty;

  let closingIndex = -1;
  for (let i = 1; i < lines.length; i += 1) {
    const trimmed = lines[i].trimEnd();
    if (trimmed === '---' || trimmed === '...') {
      closingIndex = i;
      break;
    }
  }
  if (closingIndex === -1) {
    return { present: true, malformed: true, entries: [], closingLine: 0, bodyStartLine: lines.length + 1 };
  }

  const entries                     = [];
  let malformed = false;
  let current                          = null;
  const pending           = [];

  const flush = ()       => {
    if (!current) return;
    if (pending.length > 0) {
      const joined = current.block
        ? dedent(pending).join('\n')
        : [current.value, ...pending.map((line) => line.trim())].filter((part) => part.length > 0).join(' ');
      current.value = joined;
    }
    current.value = unquote(current.value);
    entries.push(current);
    pending.length = 0;
    current = null;
  };

  for (let i = 1; i < closingIndex; i += 1) {
    const raw = lines[i];
    if (raw.trim().length === 0) {
      if (current && current.block) pending.push(raw);
      continue;
    }
    if (/^\s*#/.test(raw)) continue;

    if (/^\s/.test(raw) || raw.startsWith('-')) {
      if (!current) {
        malformed = true;
        continue;
      }
      current.endLine = i + 1;
      pending.push(raw);
      continue;
    }

    const match = KEY_LINE.exec(raw);
    if (!match) {
      malformed = true;
      continue;
    }
    flush();
    const scalar = (match[2] ?? '').trim();
    const block = scalar === '|' || scalar === '>' || scalar === '|-' || scalar === '>-';
    current = {
      key: match[1],
      value: block ? '' : scalar,
      line: i + 1,
      endLine: i + 1,
      block,
    };
  }
  flush();

  return {
    present: true,
    malformed,
    entries,
    closingLine: closingIndex + 1,
    bodyStartLine: closingIndex + 2,
  };
}

function dedent(lines          )           {
  const indents = lines.filter((line) => line.trim().length > 0).map((line) => line.length - line.trimStart().length);
  const shift = indents.length > 0 ? Math.min(...indents) : 0;
  return lines.map((line) => line.slice(shift));
}

function unquote(value        )         {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) return value.slice(1, -1);
  return value;
}

function computeFlags(tree           )             {
  let hasExecutables = false;

  for (const file of tree) {
    if (file.executable || file.path.startsWith('scripts/')) hasExecutables = true;
  }

  return { has_executables: hasExecutables };
}

const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const MAX_BODY_LINES = 500;
const MIN_DESCRIPTION_WORDS = 20;
const MAX_LINK_DEPTH = 3;

const INVISIBLE_CHARACTERS = /[​-‏‪-‮⁠-⁤﻿\u{E0000}-\u{E007F}]/gu;

const SECRET_PATTERNS                                       = [
  { label: 'aws-access-key-id', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { label: 'github-token', pattern: /\bgh[pos]_[A-Za-z0-9]{36,}\b/g },
  { label: 'slack-token', pattern: /\bxox[bpas]-[A-Za-z0-9-]{10,}/g },
  { label: 'private-key-block', pattern: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g },
];

const MARKDOWN_LINK = /\[[^\]]*\]\(([^)\s]+)\)/g;
const BARE_REFERENCE = /(?:^|[\s`("'])((?:\.\/)?(?:references|scripts|assets)\/[^\s`)<>"',;]+)/gm;

function validateSkillTree(tree           , options                           = {})             {
  const errors                = [];
  const lints                = [];

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

  const byKey = new Map                          ();
  for (const entry of parsed.entries) byKey.set(entry.key, entry);

  collectFrontmatterErrors(parsed.entries, byKey, options, errors);
  collectLints(tree, text, parsed.bodyStartLine, byKey, lints);

  const allowedTools = byKey.get('allowed-tools');
  const normalizedTree = allowedTools ? stripFrontmatterEntry(tree, manifest, text, allowedTools) : tree;

  return { errors, lints, flags: computeFlags(tree), normalizedTree };
}

function collectStructureErrors(tree           , errors               )       {
  if (tree.length > MAX_FILE_COUNT) {
    errors.push(
      finding('file_count', `the skill holds ${tree.length} files, more than the ${MAX_FILE_COUNT} allowed`, null, null)
    );
  }

  const seenPaths = new Set        ();
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

function collectContentErrors(tree           , errors               )       {
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

    const seen = new Set        ();
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
  entries                    ,
  byKey                               ,
  options                          ,
  errors               
)       {
  const allowed = new Set        (ALLOWED_FRONTMATTER_KEYS);
  const seenKeys = new Set        ();
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
  tree           ,
  text        ,
  bodyStartLine        ,
  byKey                               ,
  lints               
)       {
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

function collectReferences(text        )                                     {
  const found = new Map                                          ();
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

function normalizeReference(raw        )                {
  if (raw.includes('://') || raw.startsWith('#') || raw.startsWith('/')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;
  const withoutFragment = raw.split('#')[0].split('?')[0];
  const target = withoutFragment.replace(/^\.\//, '').replace(/\/$/, '');
  if (target.length === 0 || !target.includes('/')) return null;
  return target;
}

function stripFrontmatterEntry(tree           , manifest           , text        , entry                  )            {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const kept = splitLines(text).filter((_, index) => index + 1 < entry.line || index + 1 > entry.endLine);
  const stripped            = { ...manifest, content: Buffer.from(kept.join(eol), 'utf8') };
  return tree.map((file) => (file === manifest ? stripped : file));
}

function pathProblem(path        )                {
  if (path.length === 0) return 'the path is empty';
  if (path.startsWith('/')) return 'absolute';
  if (path.includes('\\')) return 'contains a backslash';
  const segments = path.split('/');
  if (segments.includes('..')) return "contains a '..' segment";
  if (segments.some((segment) => segment.length === 0)) return 'contains an empty segment';
  return null;
}

function finding(rule        , message        , file               , line               )              {
  return { rule, message, file, line };
}


function walk(directory, prefix) {
  const found = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name)
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) {
      found.push({ path: relative, content: Buffer.alloc(0), executable: false, symlink: true })
      continue
    }
    if (entry.isDirectory()) {
      found.push(...walk(absolute, relative))
      continue
    }
    found.push({
      path: relative,
      content: readFileSync(absolute),
      executable: (lstatSync(absolute).mode & 0o111) !== 0,
    })
  }
  return found
}

function readSkillDirectory(directory) {
  return walk(directory, "").toSorted((a, b) => a.path.localeCompare(b.path))
}

function render(findings) {
  return findings
    .map((finding) => {
      const where = finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ""}: ` : ""
      return `  [${finding.rule}] ${where}${finding.message}`
    })
    .join("\n")
}

function main(argv) {
  const args = argv.slice(2)
  const json = args.includes("--json")
  const nameIndex = args.indexOf("--name")
  const expectedName = nameIndex === -1 ? undefined : args[nameIndex + 1]
  const directory = args.find((arg) => !arg.startsWith("--") && arg !== expectedName)
  if (!directory) {
    console.error("usage: validate-skill.mjs <skill-directory> [--name <skill-name>] [--json]")
    return 2
  }

  const tree = readSkillDirectory(directory)
  const result = validateSkillTree(tree, expectedName ? { expectedName } : {})
  const report = {
    valid: result.errors.length === 0,
    errors: result.errors,
    lints: result.lints,
    flags: { hasExecutables: result.flags.has_executables },
  }

  if (json) {
    console.log(JSON.stringify(report, null, 2))
    return report.valid ? 0 : 1
  }

  if (result.errors.length > 0) {
    console.log(`ERRORS (${result.errors.length}) — the API refuses a write while any of these stand:`)
    console.log(render(result.errors))
  } else {
    console.log("ERRORS (0) — the gate would accept this tree.")
  }
  if (result.lints.length > 0) {
    console.log(`\nLINTS (${result.lints.length}) — advice; they never block a write:`)
    console.log(render(result.lints))
  }
  console.log(`\nflags: has_executables=${result.flags.has_executables}`)
  return report.valid ? 0 : 1
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv))
}
