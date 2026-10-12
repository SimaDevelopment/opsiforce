import archiver from 'archiver';
import { fileMode, REGULAR_FILE_MODE } from '../common/fs';
import { EXPORT_MANIFEST_FILE } from './export-manifest';

export interface ExportArchiveFile {
  path: string;
  content: Buffer | string;
  executable: boolean;
}

export function packExportArchive(manifest: unknown, files: ExportArchiveFile[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const chunks: Buffer[] = [];
    archive.on('data', (chunk: Buffer) => chunks.push(chunk));
    archive.on('warning', reject);
    archive.on('error', reject);
    archive.on('end', () => resolve(Buffer.concat(chunks)));

    archive.append(JSON.stringify(manifest, null, 2), { name: EXPORT_MANIFEST_FILE, mode: REGULAR_FILE_MODE });
    for (const file of files) archive.append(file.content, { name: file.path, mode: fileMode(file.executable) });
    void archive.finalize();
  });
}
