import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { serviceTestReportSchema } from '@opsiforce/external-service-sdk/platform';
import { computeManifestHash } from '@opsiforce/external-service-sdk/server';

import { runCli } from './support/cli.ts';
import { serviceFolderWith } from './support/fixtures.ts';
import { echoManifest } from './support/runtime.ts';

const lines = [
  {
    expectation: 'echo answers with its input',
    result: 'pass',
    source: 'unit-test',
    callIds: [],
  },
  {
    expectation: 'echo through the Gate answers 200 and leaves a Call row',
    result: 'pass',
    source: 'live-call',
    callIds: ['call_01J9ZK8V'],
  },
  {
    expectation: 'a write reaches only the board the brief names',
    result: 'not-checked',
    source: 'live-call',
    callIds: [],
    reason: 'no test target named',
  },
];

function git(folder: string, ...args: string[]): string {
  return execFileSync('git', ['-C', folder, ...args], { encoding: 'utf8' }).trim();
}

function committedEchoFolder(): { folder: string; commit: string } {
  const folder = serviceFolderWith({ 'service.json': JSON.stringify(echoManifest()) });
  git(folder, 'init', '-q');
  git(folder, 'add', '.');
  git(folder, '-c', 'user.name=Builder', '-c', 'user.email=builder@opsiforce.test', 'commit', '-q', '-m', 'echo');
  return { folder, commit: git(folder, 'rev-parse', 'HEAD') };
}

function linesFile(content: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), 'report-lines-')), 'lines.json');
  writeFileSync(path, JSON.stringify(content));
  return path;
}

function reportPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'report-out-')), '.cache', 'service-test-report.json');
}

test('report writes the commit, the manifest hash and the lines', () => {
  const { folder, commit } = committedEchoFolder();
  const out = reportPath();

  const run = runCli(['report', folder, '--from', linesFile({ lines }), '--out', out]);

  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /2 pass, 0 fail, 1 not checked/);
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), {
    commit,
    manifestHash: computeManifestHash(echoManifest()),
    lines,
  });
});

test('report refuses malformed lines and writes nothing', () => {
  const { folder } = committedEchoFolder();
  const out = reportPath();
  const malformed = [
    { expectation: 'echo answers', result: 'passed', source: 'unit-test', callIds: [] },
    { expectation: 'echo through the Gate', result: 'pass', source: 'live-call', callIds: [] },
    { expectation: 'not decided', result: 'not-checked', source: 'conversation', callIds: [] },
    { result: 'fail', source: 'event', callIds: [] },
  ];

  const run = runCli(['report', folder, '--from', linesFile({ lines: malformed }), '--out', out]);

  assert.equal(run.status, 1);
  assert.match(run.stdout, /lines\[0\]\.result/);
  assert.match(run.stdout, /lines\[1\]\.callIds: .*Call/);
  assert.match(run.stdout, /lines\[2\]\.reason/);
  assert.match(run.stdout, /lines\[3\]\.expectation/);
  assert.equal(existsSync(out), false);
});

test('report refuses a folder that is not a git checkout', () => {
  const folder = serviceFolderWith({ 'service.json': JSON.stringify(echoManifest()) });
  const out = reportPath();

  const run = runCli(['report', folder, '--from', linesFile({ lines }), '--out', out]);

  assert.equal(run.status, 1);
  assert.match(run.stderr, /commit/);
  assert.equal(existsSync(out), false);
});

test('report refuses an invalid service.json', () => {
  const { folder } = committedEchoFolder();
  writeFileSync(join(folder, 'service.json'), JSON.stringify({ sdk: 1 }));

  const run = runCli(['report', folder, '--from', linesFile({ lines }), '--out', reportPath()]);

  assert.equal(run.status, 1);
  assert.match(run.stdout, /^error .*displayName/m);
});

test('the report schema the Publish dialog reads accepts a written report and refuses a malformed one', () => {
  const { folder } = committedEchoFolder();
  const out = reportPath();
  runCli(['report', folder, '--from', linesFile({ lines }), '--out', out]);
  const written = JSON.parse(readFileSync(out, 'utf8'));

  assert.equal(serviceTestReportSchema.safeParse(written).success, true);
  assert.equal(serviceTestReportSchema.safeParse({ ...written, commit: 'HEAD' }).success, false);
  assert.equal(serviceTestReportSchema.safeParse({ ...written, lines: [] }).success, false);
  assert.equal(serviceTestReportSchema.safeParse({ ...written, extra: true }).success, false);
});
