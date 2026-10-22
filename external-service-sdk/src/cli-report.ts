import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';

import { formatCheck } from './check-output.ts';
import { computeManifestHash } from './manifest-hash.ts';
import { readServiceFolder } from './service-folder.ts';
import { serviceTestReportSchema, serviceTestReportPath, type ServiceTestReport } from './test-report.ts';

const run = promisify(execFile);

function formatIssuePath(path: readonly PropertyKey[]): string {
  return path.reduce<string>(
    (text, segment) =>
      typeof segment === 'number'
        ? `${text}[${segment}]`
        : text === ''
          ? String(segment)
          : `${text}.${String(segment)}`,
    ''
  );
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function readLines(from: string): Promise<unknown> {
  const text = from === '-' ? await readStdin() : await readFile(resolve(from), 'utf8');
  const parsed: unknown = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : (parsed as { lines?: unknown } | null)?.lines;
}

async function headCommit(folder: string): Promise<string> {
  try {
    const { stdout } = await run('git', ['-C', folder, 'rev-parse', '--verify', 'HEAD'], { encoding: 'utf8' });
    return stdout.trim();
  } catch {
    throw new Error(`cannot read the commit of ${folder}; report needs a git checkout with at least one commit`);
  }
}

function summary(written: ServiceTestReport): string {
  const count = (result: string) => written.lines.filter((line) => line.result === result).length;
  return `${count('pass')} pass, ${count('fail')} fail, ${count('not-checked')} not checked`;
}

export async function report(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      from: { type: 'string' },
      out: { type: 'string', default: serviceTestReportPath },
    },
  });
  if (values.from === undefined) throw new Error('report needs --from <lines.json> (or --from - for stdin)');
  const folder = resolve(positionals[0] ?? '.');

  const read = await readServiceFolder(folder);
  if (!read.check.ok) {
    process.stdout.write(formatCheck(read.check));
    return 1;
  }

  let commit: string;
  try {
    commit = await headCommit(folder);
  } catch (error) {
    process.stderr.write(`external-service-cli report: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const candidate = { commit, manifestHash: computeManifestHash(read.json), lines: await readLines(values.from) };
  const parsed = serviceTestReportSchema.safeParse(candidate);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `error   ${formatIssuePath(issue.path)}: ${issue.message}`);
    process.stdout.write(`${problems.join('\n')}\nthe report was not written\n`);
    return 1;
  }

  const out = resolve(values.out);
  await mkdir(dirname(out), { recursive: true });
  const partial = `${out}.${process.pid}.tmp`;
  await writeFile(partial, `${JSON.stringify(parsed.data, null, 2)}\n`);
  await rename(partial, out);
  process.stdout.write(`wrote ${out}: ${summary(parsed.data)} at ${commit.slice(0, 7)}\n`);
  return 0;
}
