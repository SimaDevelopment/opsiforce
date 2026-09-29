import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const BASE_CONFIG = ['-c', 'safe.directory=*', '-c', 'core.hooksPath=/dev/null'];
const COMMITTER = ['-c', 'user.email=publish@opsiforce.local', '-c', 'user.name=OpsiForce Publish'];

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
