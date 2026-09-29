import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { SkillFile, SkillTree } from '../../../src/store/gate';

export { readSkillTree } from '../../../src/store/skill-tree';

export const vendoredSkillsDir = resolve(__dirname, '../../../../agent-config/skills');

export function skillFile(path: string, content: string | Buffer, executable = false): SkillFile {
  return { path, content: typeof content === 'string' ? Buffer.from(content, 'utf8') : content, executable };
}

export function manifest(frontmatter: string, body = '# Body\n'): string {
  return `---\n${frontmatter}\n---\n\n${body}`;
}

export const validDescription =
  'Use this skill whenever the project needs a worked example of the thing it describes, including setup, pitfalls and review steps.';

export function validTree(name = 'example'): SkillTree {
  return [skillFile('SKILL.md', manifest(`name: ${name}\ndescription: ${validDescription}`))];
}

export async function vendoredSkillNames(): Promise<string[]> {
  const entries = await readdir(vendoredSkillsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .toSorted();
}

export type RawZipEntry = { name: string; content: string | Buffer; mode?: number };

export function rawZip(entries: RawZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const content = typeof entry.content === 'string' ? Buffer.from(entry.content, 'utf8') : entry.content;
    const crc = crc32(content);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(local, content);

    const header = Buffer.alloc(46 + name.length);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(0x031e, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0, 10);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(content.length, 20);
    header.writeUInt32LE(content.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(((entry.mode ?? 0o644) << 16) >>> 0, 38);
    header.writeUInt32LE(offset, 42);
    name.copy(header, 46);
    central.push(header);

    offset += local.length + content.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, end]);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
