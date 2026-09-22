import { describe, expect, it } from 'vitest';
import archiver from 'archiver';
import { MAX_FILE_BYTES, SkillArchiveError, packSkill, unpackSkill, type SkillTree } from '../../src/store/gate';
import { manifest, rawZip, skillFile, validDescription, validTree } from './support/skill-fixtures';

function buildZip(entries: { name: string; content: string | Buffer; mode?: number }[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const chunks: Buffer[] = [];
    archive.on('data', (chunk: Buffer) => chunks.push(chunk));
    archive.on('error', reject);
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    for (const entry of entries) archive.append(entry.content, { name: entry.name, mode: entry.mode ?? 0o644 });
    void archive.finalize();
  });
}

async function refusal(work: Promise<unknown>): Promise<SkillArchiveError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof SkillArchiveError) return error;
    throw error;
  }
  throw new Error('expected the archive to be refused');
}

describe('packSkill / unpackSkill', () => {
  it('round-trips a tree', async () => {
    const tree: SkillTree = [
      skillFile('SKILL.md', manifest(`name: example\ndescription: ${validDescription}`)),
      skillFile('references/notes.md', 'notes\n'),
      skillFile('scripts/run.sh', '#!/bin/sh\necho hi\n', true),
      skillFile('assets/logo.bin', Buffer.from([0, 1, 2, 250, 255])),
    ];

    const unpacked = await unpackSkill(await packSkill(tree));

    expect(sortTree(unpacked)).toEqual(sortTree(tree));
  });

  it('round-trips the executable bit', async () => {
    const [file] = await unpackSkill(await packSkill([skillFile('scripts/run.sh', 'x', true)]));
    expect(file.executable).toBe(true);
  });

  it('unpacks an archive whose root is one directory named after the skill', async () => {
    const zip = await buildZip([
      { name: 'example/SKILL.md', content: manifest(`name: example\ndescription: ${validDescription}`) },
      { name: 'example/references/notes.md', content: 'notes\n' },
    ]);

    expect((await unpackSkill(zip)).map((file) => file.path).toSorted()).toEqual(['SKILL.md', 'references/notes.md']);
  });

  it('leaves a root-level tree alone', async () => {
    const zip = await buildZip([
      { name: 'SKILL.md', content: 'x' },
      { name: 'references/notes.md', content: 'y' },
    ]);
    expect((await unpackSkill(zip)).map((file) => file.path).toSorted()).toEqual(['SKILL.md', 'references/notes.md']);
  });

  it('refuses a zip-slip path', async () => {
    const zip = rawZip([{ name: '../escape.md', content: 'x' }]);
    expect((await refusal(unpackSkill(zip))).rule).toBe('path_traversal');
  });

  it('refuses an absolute path', async () => {
    const zip = rawZip([{ name: '/etc/passwd', content: 'x' }]);
    expect((await refusal(unpackSkill(zip))).rule).toBe('path_traversal');
  });

  it('refuses a backslash path', async () => {
    const zip = rawZip([{ name: 'refs\\windows.md', content: 'x' }]);
    expect((await refusal(unpackSkill(zip))).rule).toBe('path_traversal');
  });

  it('refuses an oversize entry before inflating it', async () => {
    const zip = await buildZip([{ name: 'assets/big.txt', content: 'a'.repeat(MAX_FILE_BYTES + 1) }]);
    expect((await refusal(unpackSkill(zip))).rule).toBe('size_file');
  });

  it('refuses a tree over the total cap', async () => {
    const chunk = 'a'.repeat(MAX_FILE_BYTES);
    const zip = await buildZip(
      Array.from({ length: 6 }, (_, index) => ({ name: `assets/part-${index}.txt`, content: chunk }))
    );
    expect((await refusal(unpackSkill(zip))).rule).toBe('size_total');
  });

  it('refuses a tree whose entries inflate past their declared size', async () => {
    const chunk = 'a'.repeat(900_000);
    const entries = Array.from({ length: 10 }, (_, index) => ({ name: `assets/part-${index}.txt`, content: chunk }));
    const zip = rawZip(entries);
    const understated = understateSizes(zip);

    await expect(unpackSkill(understated)).rejects.toBeInstanceOf(SkillArchiveError);
  });

  it('refuses too many entries', async () => {
    const zip = await buildZip(
      Array.from({ length: 201 }, (_, index) => ({ name: `assets/f-${index}.txt`, content: 'x' }))
    );
    expect((await refusal(unpackSkill(zip))).rule).toBe('file_count');
  });

  it('refuses a buffer that is not a zip', async () => {
    expect((await refusal(unpackSkill(Buffer.from('not a zip')))).rule).toBe('archive_unreadable');
  });

  it('surfaces a symlink entry so the gate can refuse it', async () => {
    const zip = rawZip([
      { name: 'SKILL.md', content: 'x' },
      { name: 'link.md', content: '../../etc/passwd', mode: 0o120777 },
    ]);

    const link = (await unpackSkill(zip)).find((file) => file.path === 'link.md');
    expect(link?.symlink).toBe(true);
  });

  it('packs a tree the gate still accepts after the round trip', async () => {
    const tree = validTree('example');
    expect(await unpackSkill(await packSkill(tree))).toEqual(tree);
  });
});

function sortTree(tree: SkillTree): SkillTree {
  return [...tree].toSorted((a, b) => (a.path < b.path ? -1 : 1));
}

function understateSizes(zip: Buffer): Buffer {
  const patched = Buffer.from(zip);
  for (let offset = 0; offset < patched.length - 4; offset += 1) {
    const signature = patched.readUInt32LE(offset);
    if (signature === 0x04034b50) {
      patched.writeUInt32LE(1, offset + 22);
    } else if (signature === 0x02014b50) {
      patched.writeUInt32LE(1, offset + 24);
    }
  }
  return patched;
}
