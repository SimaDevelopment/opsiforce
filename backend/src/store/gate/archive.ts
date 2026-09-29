import archiver from 'archiver';
import type { Readable } from 'node:stream';
import yauzl from 'yauzl';
import { MAX_FILE_BYTES, MAX_FILE_COUNT, MAX_TREE_BYTES, SKILL_MANIFEST_PATH, type SkillTree } from './skill-tree';

const YAUZL_PATH_REFUSAL = /absolute path|invalid relative path|invalid characters in fileName/;

export class SkillArchiveError extends Error {
  constructor(
    readonly rule: string,
    message: string
  ) {
    super(message);
    this.name = 'SkillArchiveError';
  }
}

export function packSkill(tree: SkillTree): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const chunks: Buffer[] = [];
    archive.on('data', (chunk: Buffer) => chunks.push(chunk));
    archive.on('warning', reject);
    archive.on('error', reject);
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    for (const file of [...tree].toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
      archive.append(file.content, { name: file.path, mode: file.executable ? 0o755 : 0o644 });
    }
    void archive.finalize();
  });
}

export async function unpackSkill(buffer: Buffer): Promise<SkillTree> {
  const zip = await openBuffer(buffer);
  try {
    const entries = await collectEntries(zip);
    const files = entries.filter((entry) => !entry.fileName.endsWith('/'));
    if (files.length > MAX_FILE_COUNT) {
      throw new SkillArchiveError(
        'file_count',
        `the archive holds ${files.length} files, more than the ${MAX_FILE_COUNT} allowed`
      );
    }

    let declared = 0;
    for (const entry of files) {
      const problem = entryPathProblem(entry.fileName);
      if (problem) {
        throw new SkillArchiveError('path_traversal', `refusing archive entry \`${entry.fileName}\` (${problem})`);
      }
      if (entry.uncompressedSize > MAX_FILE_BYTES) {
        throw new SkillArchiveError(
          'size_file',
          `\`${entry.fileName}\` declares ${entry.uncompressedSize} bytes, over the ${MAX_FILE_BYTES} byte limit`
        );
      }
      declared += entry.uncompressedSize;
      if (declared > MAX_TREE_BYTES) {
        throw new SkillArchiveError(
          'size_total',
          `the archive declares more than the ${MAX_TREE_BYTES} byte limit for a skill`
        );
      }
    }

    const tree: SkillTree = [];
    let inflated = 0;
    for (const entry of files) {
      const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
      const content = await readEntry(zip, entry);
      inflated += content.length;
      if (inflated > MAX_TREE_BYTES) {
        throw new SkillArchiveError(
          'size_total',
          `the archive inflates past the ${MAX_TREE_BYTES} byte limit for a skill`
        );
      }
      tree.push({
        path: entry.fileName,
        content,
        executable: (mode & 0o111) !== 0,
        ...((mode & 0o170000) === 0o120000 ? { symlink: true } : {}),
      });
    }
    return stripArchiveRoot(tree);
  } finally {
    zip.close();
  }
}

function stripArchiveRoot(tree: SkillTree): SkillTree {
  if (tree.length === 0) return tree;
  if (tree.some((file) => file.path === SKILL_MANIFEST_PATH)) return tree;
  const roots = new Set(tree.map((file) => file.path.split('/')[0]));
  if (roots.size !== 1) return tree;
  const [root] = roots;
  if (tree.some((file) => file.path === root)) return tree;
  return tree.map((file) => ({ ...file, path: file.path.slice(root.length + 1) }));
}

function entryPathProblem(path: string): string | null {
  if (path.length === 0) return 'the path is empty';
  if (path.startsWith('/')) return 'absolute';
  if (path.includes('\\')) return 'contains a backslash';
  if (/^[A-Za-z]:/.test(path)) return 'has a drive letter';
  const segments = path.split('/');
  if (segments.includes('..')) return "contains a '..' segment";
  if (segments.some((segment) => segment.length === 0)) return 'contains an empty segment';
  return null;
}

function toArchiveError(error: unknown): SkillArchiveError {
  if (error instanceof SkillArchiveError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (YAUZL_PATH_REFUSAL.test(message))
    return new SkillArchiveError('path_traversal', `refusing archive entry: ${message}`);
  return new SkillArchiveError('archive_unreadable', message);
}

function openBuffer(buffer: Buffer): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, autoClose: false, strictFileNames: true }, (error, zip) => {
      if (error || !zip) {
        reject(toArchiveError(error ?? 'the archive could not be read'));
        return;
      }
      resolve(zip);
    });
  });
}

function collectEntries(zip: yauzl.ZipFile): Promise<yauzl.Entry[]> {
  return new Promise((resolve, reject) => {
    const entries: yauzl.Entry[] = [];
    zip.on('entry', (entry: yauzl.Entry) => {
      entries.push(entry);
      zip.readEntry();
    });
    zip.on('end', () => resolve(entries));
    zip.on('error', (error: unknown) => reject(toArchiveError(error)));
    zip.readEntry();
  });
}

async function readEntry(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<Buffer> {
  const stream = await openEntryStream(zip, entry);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += (chunk as Buffer).length;
    if (size > MAX_FILE_BYTES) {
      throw new SkillArchiveError('size_file', `\`${entry.fileName}\` inflates past the ${MAX_FILE_BYTES} byte limit`);
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function openEntryStream(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(
          new SkillArchiveError('archive_unreadable', error?.message ?? `\`${entry.fileName}\` could not be read`)
        );
        return;
      }
      resolve(stream);
    });
  });
}
