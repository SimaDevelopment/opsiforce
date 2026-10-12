import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const BASE_CONFIG = ['-c', 'safe.directory=*', '-c', 'core.hooksPath=/dev/null'];
const COMMITTER = ['-c', 'user.email=publish@opsiforce.local', '-c', 'user.name=OpsiForce Publish'];
const EXECUTABLE_BLOB_MODE = '100755';
const COMMITTED_FILE_MODES = new Set(['100644', EXECUTABLE_BLOB_MODE]);
const MAX_BLOB_BYTES = 256 * 1024 * 1024;

export interface CommittedFile {
  path: string;
  content: Buffer;
  executable: boolean;
}

function splitOnce(text: string, separator: string): [string, string] {
  const index = text.indexOf(separator);
  return index < 0 ? [text, ''] : [text.slice(0, index), text.slice(index + separator.length)];
}

@Injectable()
export class GitService {
  private readonly logger = new Logger(GitService.name);

  private async git(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await run('git', [...BASE_CONFIG, ...args], { cwd, maxBuffer: 32 * 1024 * 1024 });
    return stdout.trim();
  }

  async currentSha(dir: string): Promise<string> {
    return this.git(dir, ['rev-parse', 'HEAD']);
  }

  async commitWorkingTree(dir: string, message: string): Promise<string> {
    await this.git(dir, ['add', '-A']);
    const staged = await this.git(dir, ['status', '--porcelain']);
    if (staged.length > 0) {
      await this.git(dir, [...COMMITTER, 'commit', '--no-verify', '-m', message]);
    }
    return this.currentSha(dir);
  }

  /** Commits only `paths`, leaving whatever else the working tree or index holds untouched. */
  async commitPaths(dir: string, paths: string[], message: string): Promise<string> {
    const tracked = await this.withoutIgnored(dir, paths);
    if (tracked.length > 0) {
      await this.git(dir, ['add', '--', ...tracked]);
      const staged = await this.git(dir, ['diff', '--cached', '--name-only', '--', ...tracked]);
      if (staged.length > 0) {
        await this.git(dir, [...COMMITTER, 'commit', '--no-verify', '-m', message, '--only', '--', ...tracked]);
      }
    }
    return this.currentSha(dir);
  }

  private async withoutIgnored(dir: string, paths: string[]): Promise<string[]> {
    if (paths.length === 0) return [];
    const ignored = await run('git', [...BASE_CONFIG, 'check-ignore', '--', ...paths], {
      cwd: dir,
      maxBuffer: 32 * 1024 * 1024,
    }).then(
      ({ stdout }) => stdout,
      (err: { code?: number; stdout?: string }) => {
        if (err.code === 1) return '';
        throw err;
      }
    );
    const skipped = new Set(ignored.split('\n').filter((line) => line.length > 0));
    return paths.filter((file) => !skipped.has(file));
  }

  async cloneLocal(srcDir: string, destDir: string): Promise<void> {
    await run('git', [...BASE_CONFIG, 'clone', '--local', srcDir, destDir], { maxBuffer: 32 * 1024 * 1024 });
  }

  async cloneNoCheckout(srcDir: string, destDir: string): Promise<void> {
    await run('git', [...BASE_CONFIG, 'clone', '--local', '--no-checkout', srcDir, destDir], {
      maxBuffer: 32 * 1024 * 1024,
    });
  }

  async fetchOrigin(dir: string): Promise<void> {
    await this.git(dir, ['fetch', 'origin', '--prune']);
  }

  async resetHard(dir: string, sha: string): Promise<void> {
    await this.git(dir, ['reset', '--hard', sha]);
  }

  async removeOrigin(dir: string): Promise<void> {
    await this.git(dir, ['remote', 'remove', 'origin']).catch((err) => {
      this.logger.debug(`No origin remote to remove at ${dir}: ${(err as Error).message}`);
    });
  }

  async listIgnored(dir: string): Promise<string[]> {
    const stdout = await this.git(dir, [
      '-c',
      'core.quotePath=false',
      'ls-files',
      '--others',
      '--ignored',
      '--exclude-standard',
      '--directory',
    ]);
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => (line.endsWith('/') ? line.slice(0, -1) : line));
  }

  async changedSince(dir: string, commit: string): Promise<string[]> {
    const quoted = ['-c', 'core.quotePath=false'];
    const changed = await this.git(dir, [...quoted, 'diff', '--name-only', commit, '--']);
    const untracked = await this.git(dir, [...quoted, 'ls-files', '--others', '--exclude-standard']);
    return [...new Set([...changed.split('\n'), ...untracked.split('\n')])]
      .filter((line) => line.length > 0)
      .toSorted();
  }

  async committedFiles(dir: string, folder: string): Promise<CommittedFile[]> {
    if (!(await this.hasCommits(dir))) return [];
    const listing = await this.git(dir, ['-c', 'core.quotePath=false', 'ls-tree', '-r', '-z', 'HEAD', '--', folder]);
    const prefix = `${folder}/`;
    const files: CommittedFile[] = [];
    for (const line of listing.split('\0').filter((entry) => entry.length > 0)) {
      const [meta, path] = splitOnce(line, '\t');
      const [mode, type, object] = meta.split(' ');
      if (type !== 'blob' || !COMMITTED_FILE_MODES.has(mode) || !path.startsWith(prefix)) continue;
      const { stdout } = await run('git', [...BASE_CONFIG, 'cat-file', 'blob', object], {
        cwd: dir,
        encoding: 'buffer',
        maxBuffer: MAX_BLOB_BYTES,
      });
      files.push({ path: path.slice(prefix.length), content: stdout, executable: mode === EXECUTABLE_BLOB_MODE });
    }
    return files;
  }

  async trackedFiles(dir: string, folder: string): Promise<string[]> {
    const listing = await this.git(dir, ['-c', 'core.quotePath=false', 'ls-files', '-z', '--', folder]);
    return listing.split('\0').filter((entry) => entry.length > 0);
  }

  private async hasCommits(dir: string): Promise<boolean> {
    try {
      await this.git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD']);
      return true;
    } catch (err) {
      this.logger.debug(`No commits at ${dir}: ${(err as Error).message}`);
      return false;
    }
  }

  async isRepo(dir: string): Promise<boolean> {
    try {
      await this.git(dir, ['rev-parse', '--git-dir']);
      return true;
    } catch (err) {
      this.logger.debug(`Not a git repository at ${dir}: ${(err as Error).message}`);
      return false;
    }
  }
}
