import { posix } from 'node:path';

export type TemplateEntryKind = 'file' | 'directory' | 'symlink' | 'other';

export interface TemplateEntry {
  path: string;
  kind: TemplateEntryKind;
}

export type TemplateVerdict = 'refused' | 'skipped';

export interface TemplateRule {
  verdict: TemplateVerdict;
  rule: string;
  reason: string;
  matches: (entry: TemplateEntry) => boolean;
}

export interface TemplateRuling {
  verdict: TemplateVerdict;
  rule: string;
  reason: string;
}

export const GITIGNORED_RULING: TemplateRuling = {
  verdict: 'skipped',
  rule: 'gitignored',
  reason: "excluded by the Template's own .gitignore",
};

const INSTRUCTION_REASON = 'opencode would load it as instructions, config or Skills beside the Agent prompt';

function nameOf(entry: TemplateEntry): string {
  return posix.basename(entry.path);
}

function parentNameOf(entry: TemplateEntry): string {
  return posix.basename(posix.dirname(entry.path));
}

function atRoot(entry: TemplateEntry): boolean {
  return !entry.path.includes('/');
}

function folderNamed(...names: string[]): (entry: TemplateEntry) => boolean {
  const wanted = new Set(names);
  return (entry) => entry.kind !== 'file' && wanted.has(nameOf(entry));
}

function underYarnNamed(...names: string[]): (entry: TemplateEntry) => boolean {
  const wanted = new Set(names);
  return (entry) => parentNameOf(entry) === '.yarn' && wanted.has(nameOf(entry));
}

function isRefusedEnvFile(entry: TemplateEntry): boolean {
  const name = nameOf(entry);
  return entry.kind !== 'directory' && name.startsWith('.env') && !name.endsWith('.example');
}

const PLATFORM_APP_FILES = new Set(['app/opsiforce.env.json', 'app/app.meta.json']);

export const TEMPLATE_RULES: readonly TemplateRule[] = [
  {
    verdict: 'skipped',
    rule: 'instruction-file',
    reason: INSTRUCTION_REASON,
    matches: (entry) => entry.kind !== 'directory' && nameOf(entry) === 'AGENTS.md',
  },
  {
    verdict: 'skipped',
    rule: 'instruction-file',
    reason: INSTRUCTION_REASON,
    matches: (entry) =>
      entry.kind !== 'directory' && atRoot(entry) && ['opencode.json', 'opencode.jsonc'].includes(nameOf(entry)),
  },
  {
    verdict: 'skipped',
    rule: 'instruction-file',
    reason: INSTRUCTION_REASON,
    matches: folderNamed('.claude', '.agents'),
  },
  {
    verdict: 'skipped',
    rule: 'platform-folder',
    reason: 'the platform keeps its own state there',
    matches: (entry) => nameOf(entry) === '.git' || folderNamed('.opencode', '.opsiforce', '.xdg')(entry),
  },
  {
    verdict: 'skipped',
    rule: 'dependencies',
    reason: 'installed dependencies and package-manager state are rebuilt in each Project',
    matches: (entry) =>
      folderNamed('node_modules', '.pnpm-store')(entry) ||
      underYarnNamed('cache', 'unplugged', 'sdks', 'build-state.yml', 'install-state.gz')(entry) ||
      nameOf(entry).startsWith('.pnp.'),
  },
  {
    verdict: 'skipped',
    rule: 'data',
    reason: 'a data/ folder holds one Project’s runtime data',
    matches: folderNamed('data'),
  },
  {
    verdict: 'skipped',
    rule: 'cache',
    reason: 'caches are rebuilt in each Project',
    matches: folderNamed('.cache', '.config', '.bun'),
  },
  {
    verdict: 'skipped',
    rule: 'chat-files',
    reason: 'uploads and generated files belong to one chat, not to every Project',
    matches: folderNamed('user_uploaded_files', 'generated_files'),
  },
  {
    verdict: 'refused',
    rule: 'symlink',
    reason: 'a symlink could point outside the Template; copy the file in instead',
    matches: (entry) => entry.kind === 'symlink',
  },
  {
    verdict: 'refused',
    rule: 'platform-app-file',
    reason: 'the platform writes this file for each Project',
    matches: (entry) => PLATFORM_APP_FILES.has(entry.path),
  },
  {
    verdict: 'refused',
    rule: 'env-file',
    reason: 'secrets belong in Environment settings; ship a `.env.example` instead',
    matches: isRefusedEnvFile,
  },
  {
    verdict: 'refused',
    rule: 'special-file',
    reason: 'only regular files and folders can be saved',
    matches: (entry) => entry.kind === 'other',
  },
];

export function ruleOn(entry: TemplateEntry): TemplateRuling | null {
  const rule = TEMPLATE_RULES.find((candidate) => candidate.matches(entry));
  return rule ? { verdict: rule.verdict, rule: rule.rule, reason: rule.reason } : null;
}
