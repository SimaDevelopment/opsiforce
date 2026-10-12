import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

interface SourcePackage {
  name: string;
  version: string;
  type: string;
  description?: string;
  bin: Record<string, string>;
  exports: Record<string, string>;
  dependencies: Record<string, string>;
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readingCopyName = 'latest';
const copiedFiles = ['README.md', 'CHANGELOG.md', 'service.schema.json'];
const platformOnlyExports = new Set(['./forms', './platform']);
const fixedMtimeSeconds = 499162500;
const tarBlock = 512;
const requireFromPackage = createRequire(join(packageRoot, 'package.json'));

function compiledPath(sourcePath: string, extension: '.js' | '.d.ts'): string {
  return sourcePath.replace(/^\.\/src\//, './dist/').replace(/\.ts$/, extension);
}

function packedExports(exports: Record<string, string>): Record<string, string | { types: string; default: string }> {
  return Object.fromEntries(
    Object.entries(exports)
      .filter(([subpath]) => !platformOnlyExports.has(subpath))
      .map(([subpath, target]) => [
        subpath,
        target.endsWith('.ts')
          ? { types: compiledPath(target, '.d.ts'), default: compiledPath(target, '.js') }
          : target,
      ])
  );
}

function installedVersion(dependency: string): string {
  return (JSON.parse(readFileSync(requireFromPackage.resolve(`${dependency}/package.json`), 'utf8')) as SourcePackage)
    .version;
}

function pinnedDependencies(dependencies: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.keys(dependencies).map((name) => [name, installedVersion(name)]));
}

function packedPackageJson(source: SourcePackage): object {
  return {
    name: source.name,
    version: source.version,
    description: source.description,
    type: source.type,
    bin: Object.fromEntries(Object.entries(source.bin).map(([name, target]) => [name, compiledPath(target, '.js')])),
    files: ['dist', ...copiedFiles],
    exports: packedExports(source.exports),
    dependencies: pinnedDependencies(source.dependencies),
  };
}

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`);
}

function filesUnder(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, '0')}\0`;
}

function tarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(tarBlock);
  const splitAt = name.length > 100 ? name.lastIndexOf('/', 155) : -1;
  const [prefix, base] = splitAt === -1 ? ['', name] : [name.slice(0, splitAt), name.slice(splitAt + 1)];
  if (Buffer.byteLength(base) > 100 || Buffer.byteLength(prefix) > 155) throw new Error(`${name} is too long to pack`);
  header.write(base, 0, 100, 'utf8');
  header.write(octal(0o644, 8), 100, 8, 'ascii');
  header.write(octal(0, 8), 108, 8, 'ascii');
  header.write(octal(0, 8), 116, 8, 'ascii');
  header.write(octal(size, 12), 124, 12, 'ascii');
  header.write(octal(fixedMtimeSeconds, 12), 136, 12, 'ascii');
  header.write(' '.repeat(8), 148, 8, 'ascii');
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  header.write(prefix, 345, 155, 'utf8');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

function reproducibleTarball(root: string, folder: string): Buffer {
  const entries = filesUnder(join(root, folder))
    .map((path) => ({ path, name: relative(root, path).split(sep).join('/') }))
    .toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const blocks = entries.flatMap(({ path, name }) => {
    const content = readFileSync(path);
    const padding = Buffer.alloc((tarBlock - (content.length % tarBlock)) % tarBlock);
    return [tarHeader(name, content.length), content, padding];
  });
  const gzipped = gzipSync(Buffer.concat([...blocks, Buffer.alloc(tarBlock * 2)]), { level: 9 });
  gzipped[9] = 255;
  return gzipped;
}

const target = process.argv[2];
if (!target) {
  process.stderr.write('Usage: node scripts/pack-sdk.ts <output folder>\n');
  process.exit(2);
}
const out = resolve(target);
const source = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as SourcePackage;
const tarball = join(out, `external-service-sdk-${source.version}.tgz`);
const staging = join(out, 'staging');
const stagedPackage = join(staging, 'package');

rmSync(staging, { recursive: true, force: true });
mkdirSync(stagedPackage, { recursive: true });

const tsc = requireFromPackage.resolve('typescript/bin/tsc');
run(
  process.execPath,
  [tsc, '-p', join(packageRoot, 'tsconfig.pack.json'), '--outDir', join(stagedPackage, 'dist')],
  packageRoot
);

for (const file of copiedFiles) copyFileSync(join(packageRoot, file), join(stagedPackage, file));
writeFileSync(join(stagedPackage, 'package.json'), `${JSON.stringify(packedPackageJson(source), null, 2)}\n`);

writeFileSync(tarball, reproducibleTarball(staging, 'package'));

const readingCopy = join(out, readingCopyName);
rmSync(readingCopy, { recursive: true, force: true });
renameSync(stagedPackage, readingCopy);
rmSync(staging, { recursive: true, force: true });

process.stdout.write(`packed ${tarball}\n`);
