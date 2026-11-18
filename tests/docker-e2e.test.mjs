// Real-stack tests. They need a Docker daemon, so they run only when asked:
//   FACTORY_E2E=1 npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { project, cli, git, withRecords, acceptanceFor } from './helpers.mjs';

const enabled = process.env.FACTORY_E2E === '1';
const FIX = "export function normalizeTitle(title) {\n  if (typeof title !== 'string') return null;\n  const trimmed = title.trim();\n  return trimmed === '' ? null : trimmed;\n}\n";
const factoryContainers = () => spawnSync('docker', ['ps', '-a', '--format', '{{.Label "com.docker.compose.project"}}'], { encoding: 'utf8' }).stdout.split('\n').filter((p) => p.startsWith('factory-'));

test('builder branches integrate into a retained worktree and the combined candidate is gated', { skip: !enabled }, (t) => {
  const dir = project(t);
  const parent = { ...JSON.parse(fs.readFileSync(path.join(dir, 'tasks/trim-note-titles.json'), 'utf8')), id: 'titles', allowed_paths: ['src'] };
  const plan = { schema_version: 1, task: parent, nodes: [
    { task: { ...parent, id: 'normalize', allowed_paths: ['src/title.mjs'] } },
    { task: { ...parent, id: 'notes-doc', allowed_paths: ['src/NOTES.md'] } },
  ] };
  const planFile = path.join(os.tmpdir(), `plan-${process.pid}.json`);
  t.after(() => fs.rmSync(planFile, { force: true }));
  fs.writeFileSync(planFile, JSON.stringify(withRecords(plan)));
  assert.equal(cli(dir, ['approve-plan', planFile]).code, 0);
  for (const [branch, file, body] of [['b/normalize', 'src/title.mjs', FIX], ['b/notes-doc', 'src/NOTES.md', '# Notes\n']]) {
    git(dir, 'checkout', '-q', '-b', branch, 'main');
    fs.writeFileSync(path.join(dir, file), body);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', branch);
  }
  git(dir, 'checkout', '-q', 'main');
  const main = git(dir, 'rev-parse', 'main').stdout;
  const r = cli(dir, ['integrate', 'titles', '--branch', 'normalize=b/normalize', '--branch', 'notes-doc=b/notes-doc', '--json']);
  assert.equal(r.code, 0, r.out + r.err);
  const result = JSON.parse(r.out);
  assert.equal(result.passed, true);
  assert.equal(result.checks.find((c) => c.id === 'compose:e2e').status, 'PASS');
  assert.match(result.worktree, /\.claude\/worktrees\/factory-integration-titles-/);
  assert.equal(git(dir, 'rev-parse', 'main').stdout, main, 'the owner\'s branch is untouched');
  assert.deepEqual(factoryContainers(), []);
});

test('a managed run retries a headless session until the controller\'s gate passes', { skip: !enabled }, (t) => {
  const dir = project(t);
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-'));
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  // Stands in for `claude -p`: the first attempt is wrong, the second repairs it.
  const fake = path.join(bin, 'claude');
  fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require('fs');
const prompt = fs.readFileSync(0, 'utf8');
if (process.env.CLAUDE_FACTORY_MANAGED !== '1') process.exit(3);
const retry = prompt.includes('previous attempt failed');
fs.writeFileSync('src/title.mjs', retry ? ${JSON.stringify(FIX)} : "export const normalizeTitle = (t) => t;\\n");
console.log(JSON.stringify({ total_cost_usd: 0.01 }));
`);
  fs.chmodSync(fake, 0o755);
  const task = path.join(os.tmpdir(), `task-${process.pid}.json`);
  t.after(() => fs.rmSync(task, { force: true }));
  fs.copyFileSync(path.join(dir, 'tasks/trim-note-titles.json'), task);
  const r = cli(dir, ['run', task, '--acceptance', acceptanceFor(dir, task), '--json'], { CLAUDE_FACTORY_CLAUDE_BIN: fake });
  assert.equal(r.code, 0, r.out + r.err);
  const result = JSON.parse(r.out);
  assert.equal(result.passed, true);
  assert.equal(result.attempts, 2);
  assert.deepEqual(factoryContainers(), []);
});

test('a criterion with a manual observation stays pending until the owner records it on that candidate', { skip: !enabled }, async (t) => {
  const { activate, hook } = await import('./helpers.mjs');
  const dir = project(t);
  const r = activate(dir, 'tasks/trim-note-titles.json', (rec) => ({ ...rec, criteria: rec.criteria.map((c, i) => (i === 0 ? { ...c, manual: ['The page shows the trimmed title after a reload'] } : c)) }));
  assert.equal(r.code, 0, r.err);
  fs.writeFileSync(path.join(dir, 'src/title.mjs'), FIX);
  const out = hook({ hook_event_name: 'Stop', cwd: dir, permission_mode: 'default' }).json;
  assert.match(out.systemMessage, /waits for the owner's manual observation/, 'automated checks passed, so the agent is not sent back to work');
  let v = cli(dir, ['verify', '--json']);
  let result = JSON.parse(v.out);
  assert.equal(v.code, 1);
  assert.equal(result.status, 'pending');
  assert.equal(result.passed, false);
  assert.equal(result.checks.find((c) => c.id === 'compose:e2e').status, 'PASS');
  assert.equal(result.checks.find((c) => c.id === 'acceptance').status, 'NOT_RUN');
  assert.equal(cli(dir, ['evidence', 'c1', '--note', 'Reloaded the page and saw the trimmed title']).code, 0);
  v = cli(dir, ['verify', '--json']);
  result = JSON.parse(v.out);
  assert.equal(result.status, 'passed', v.out);
  assert.equal(result.checks.find((c) => c.id === 'acceptance').status, 'PASS');
});
