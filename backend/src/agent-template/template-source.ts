import { spawn } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { lstat, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { compareSkillPaths } from '../store/gate';
import { GITIGNORED_RULING, ruleOn, type TemplateEntry, type TemplateEntryKind } from './template-filter';
import type { TemplatePathNote } from './agent-template.types';

export interface TemplateSourceFile {
  path: string;
  absolute: string;
  executable: boolean;
}

export interface TemplateRefusal {
  path: string;
  rule: string;
  reason: string;
}

export interface TemplateSource {
  files: TemplateSourceFile[];
  skipped: TemplatePathNote[];
  refused: TemplateRefusal[];
}

const GITIGNORE = '.gitignore';

export async function scanTemplateSource(sourceDir: string): Promise<TemplateSource> {
  const source: TemplateSource = { files: [], skipped: [], refused: [] };
  if (!(await isDirectory(sourceDir))) return source;

  const ignores = new GitignoreProbe(sourceDir);
  try {
    await walk(sourceDir, '', false, ignores, source);
  } finally {
    await ignores.dispose();
  }
  source.files.sort((a, b) => compareSkillPaths(a.path, b.path));
  source.skipped.sort((a, b) => compareSkillPaths(a.path, b.path));
  source.refused.sort((a, b) => compareSkillPaths(a.path, b.path));
  return source;
}

async function walk(
  sourceDir: string,
  relativeDir: string,
  gitignoreAbove: boolean,
  ignores: GitignoreProbe,
  source: TemplateSource
): Promise<void> {
  const dirents = await readdir(join(sourceDir, relativeDir), { withFileTypes: true });
  const gitignoreInScope = gitignoreAbove || dirents.some((dirent) => dirent.name === GITIGNORE && dirent.isFile());

  const candidates: TemplateEntry[] = [];
  for (const dirent of dirents) {
    const entry = { path: relativeDir ? posix.join(relativeDir, dirent.name) : dirent.name, kind: kindOf(dirent) };
    const ruling = ruleOn(entry);
    if (ruling?.verdict === 'refused')
      source.refused.push({ path: entry.path, rule: ruling.rule, reason: ruling.reason });
    else if (ruling) source.skipped.push({ path: entry.path, reason: ruling.reason });
    else candidates.push(entry);
  }

  const ignored = gitignoreInScope ? await ignores.ignored(candidates.map((entry) => entry.path)) : new Set<string>();
  for (const entry of candidates) {
    if (ignored.has(entry.path)) {
      source.skipped.push({ path: entry.path, reason: GITIGNORED_RULING.reason });
    } else if (entry.kind === 'directory') {
      await walk(sourceDir, entry.path, gitignoreInScope, ignores, source);
    } else {
      const absolute = join(sourceDir, entry.path);
      const stats = await lstat(absolute);
      source.files.push({ path: entry.path, absolute, executable: (stats.mode & 0o111) !== 0 });
    }
  }
}

function kindOf(dirent: Dirent): TemplateEntryKind {
  if (dirent.isSymbolicLink()) return 'symlink';
  if (dirent.isDirectory()) return 'directory';
  if (dirent.isFile()) return 'file';
  return 'other';
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

class GitignoreProbe {
  private gitDir: Promise<string> | null = null;

  constructor(private readonly workTree: string) {}

  async ignored(paths: string[]): Promise<Set<string>> {
    if (paths.length === 0) return new Set();
    const gitDir = await (this.gitDir ??= this.createGitDir());
    const output = await runGit(
      [
        '--git-dir',
        gitDir,
        '--work-tree',
        '.',
        '-c',
        'core.excludesFile=/dev/null',
        'check-ignore',
        '--no-index',
        '-z',
        '--stdin',
      ],
      this.workTree,
      paths.map((path) => `${path}\0`).join('')
    );
    return new Set(output.split('\0').filter((path) => path.length > 0));
  }

  async dispose(): Promise<void> {
    if (!this.gitDir) return;
    await rm(await this.gitDir, { recursive: true, force: true });
  }

  private async createGitDir(): Promise<string> {
    const gitDir = await mkdtemp(join(tmpdir(), 'opsiforce-template-ignore-'));
    await runGit(['init', '--quiet', '--bare', gitDir], this.workTree, '');
    return gitDir;
  }
}

const CHECK_IGNORE_MATCHED_NOTHING = 1;

function runGit(args: string[], cwd: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', 'safe.directory=*', ...args], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0 || code === CHECK_IGNORE_MATCHED_NOTHING) resolve(Buffer.concat(stdout).toString('utf8'));
      else reject(new Error(`git ${args.join(' ')} exited ${code}: ${Buffer.concat(stderr).toString('utf8').trim()}`));
    });
    child.stdin.end(input);
  });
}
