import { Injectable } from '@nestjs/common';
import { lstat, readdir } from 'fs/promises';
import path from 'path';
import { GitService } from '../git/git.service';

export interface ProjectFileEntry {
  relPath: string;
  source: string;
  size: number;
  mode: number;
  uid: number;
  gid: number;
  type: 'file' | 'directory' | 'symlink';
}

function isEphemeralCache(relPath: string): boolean {
  const segments = relPath.split('/');
  if (segments.includes('.cache')) return true;
  if (segments.includes('.bun')) return true;
  if (relPath === '.xdg/cache' || relPath.startsWith('.xdg/cache/')) return true;
  return false;
}

@Injectable()
export class ProjectFilesService {
  constructor(private readonly gitService: GitService) {}

  async collectRuntimeEntries(sourceRoot: string): Promise<ProjectFileEntry[]> {
    const ignored = await this.gitService.listIgnored(sourceRoot);
    const entries: ProjectFileEntry[] = [];
    for (const relPath of ignored) {
      await this.walk(path.join(sourceRoot, relPath), relPath, entries);
    }
    return entries;
  }

  private async walk(source: string, relPath: string, entries: ProjectFileEntry[]): Promise<void> {
    if (isEphemeralCache(relPath)) return;

    const stats = await lstat(source).catch(() => null);
    if (!stats) return;

    const { mode, uid, gid } = stats;

    if (stats.isDirectory()) {
      entries.push({ relPath, source, size: 0, mode, uid, gid, type: 'directory' });
      const children = await readdir(source);
      for (const child of children) {
        await this.walk(path.join(source, child), `${relPath}/${child}`, entries);
      }
      return;
    }

    if (stats.isSymbolicLink()) {
      entries.push({ relPath, source, size: 0, mode, uid, gid, type: 'symlink' });
      return;
    }

    if (stats.isFile()) {
      entries.push({ relPath, source, size: stats.size, mode, uid, gid, type: 'file' });
    }
  }
}
