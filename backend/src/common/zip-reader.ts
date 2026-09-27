import { createWriteStream } from 'node:fs';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';

const SYMLINK_MODE = 0o120000;
const FILE_TYPE_MASK = 0o170000;

export function entryMode(entry: yauzl.Entry): number {
  return (entry.externalFileAttributes >>> 16) & 0xffff;
}

export function isSymlinkMode(mode: number): boolean {
  return (mode & FILE_TYPE_MASK) === SYMLINK_MODE;
}

export function openZip(filePath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: false }, (error, zip) => {
      if (error || !zip) reject(error ?? new Error('Failed to open archive'));
      else resolve(zip);
    });
  });
}

export async function* entriesOf(zip: yauzl.ZipFile): AsyncGenerator<yauzl.Entry> {
  for (;;) {
    const entry = await new Promise<yauzl.Entry | null>((resolve, reject) => {
      const onEntry = (next: yauzl.Entry) => settle(() => resolve(next));
      const onEnd = () => settle(() => resolve(null));
      const onError = (error: Error) => settle(() => reject(error));
      const settle = (done: () => void) => {
        zip.off('entry', onEntry);
        zip.off('end', onEnd);
        zip.off('error', onError);
        done();
      };
      zip.on('entry', onEntry);
      zip.on('end', onEnd);
      zip.on('error', onError);
      zip.readEntry();
    });
    if (!entry) return;
    yield entry;
  }
}

export async function collectEntries(zip: yauzl.ZipFile): Promise<yauzl.Entry[]> {
  const entries: yauzl.Entry[] = [];
  for await (const entry of entriesOf(zip)) entries.push(entry);
  return entries;
}

export function openEntry(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) reject(error ?? new Error('Failed to read archive entry'));
      else resolve(stream);
    });
  });
}

export async function readEntry(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of await openEntry(zip, entry)) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export async function readNamedEntry(zip: yauzl.ZipFile, name: string): Promise<Buffer | null> {
  for await (const entry of entriesOf(zip)) {
    if (entry.fileName === name) return readEntry(zip, entry);
  }
  return null;
}

export async function writeEntryToFile(zip: yauzl.ZipFile, entry: yauzl.Entry, target: string): Promise<void> {
  await pipeline(await openEntry(zip, entry), createWriteStream(target));
}
