// Regression cases from the independent gate review of e94fb5c. These run
// without Docker: each must fail before the stack would be booted.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { project, cli, hook, git, pathWithoutDocker } from './helpers.mjs';
import { auditDiff } from '../plugins/harness/lib/audit.mjs';
import { lintModel } from '../plugins/harness/lib/compose.mjs';

const TASK = 'tasks/trim-note-titles.json';
const FIX = "export const normalizeTitle = (t) => (typeof t === 'string' && t.trim() ? t.trim() : null);\n";
const verify = (dir, env) => JSON.parse(cli(dir, ['verify', '--json'], env).out);
const scope = (r) => r.checks.find((c) => c.id === 'scope');
const stopEvent = (dir) => ({ hook_event_name: 'Stop', cwd: dir, permission_mode: 'default' });

test('C2: index flags and replace refs cannot hide a tampered acceptance test', (t) => {
  const dir = project(t);
  cli(dir, ['activate', TASK]);
  fs.writeFileSync(path.join(dir, 'src/title.mjs'), FIX);
  git(dir, 'update-index', '--skip-worktree', 'acceptance/e2e.mjs');
  fs.writeFileSync(path.join(dir, 'acceptance/e2e.mjs'), 'console.log("ok")\n');
  let r = verify(dir);
  assert.equal(r.status, 'blocked');
  assert.ok(scope(r).details.some((d) => d.includes('acceptance/e2e.mjs')), scope(r).details.join());
  git(dir, 'update-index', '--no-skip-worktree', 'acceptance/e2e.mjs');
  git(dir, 'update-index', '--assume-unchanged', 'acceptance/e2e.mjs');
  assert.equal(verify(dir).status, 'blocked');

  const dir2 = project(t);
  const base = git(dir2, 'rev-parse', 'HEAD').stdout.trim();
  cli(dir2, ['activate', TASK]);
  fs.writeFileSync(path.join(dir2, 'acceptance/e2e.mjs'), 'console.log("ok")\n');
  git(dir2, 'commit', '-qam', 'tamper');
  git(dir2, 'replace', base, 'HEAD');
  r = verify(dir2);
  assert.equal(r.status, 'blocked', 'git replace must not move the base');
});

test('C4: nested repositories and new ignore rules fail scope', (t) => {
  const dir = project(t);
  cli(dir, ['activate', TASK]);
  fs.mkdirSync(path.join(dir, 'src/lib'));
  git(path.join(dir, 'src/lib'), 'init', '-q');
  fs.writeFileSync(path.join(dir, 'src/lib/x.mjs'), 'eval("1")\n');
  git(path.join(dir, 'src/lib'), 'add', '-A');
  git(path.join(dir, 'src/lib'), 'commit', '-qm', 'x');
  let r = verify(dir);
  assert.equal(r.status, 'blocked');
  assert.ok(scope(r).details.some((d) => d.includes('nested repository')));
  fs.rmSync(path.join(dir, 'src/lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/.gitignore'), '*\n');
  fs.writeFileSync(path.join(dir, 'src/hidden.mjs'), 'eval("1")\n');
  r = verify(dir);
  assert.equal(r.status, 'blocked');
  assert.ok(scope(r).details.some((d) => d.includes('ignore rules')), scope(r).details.join());
});

test('C3: a run without an active task is a baseline, never a pass', (t) => {
  const dir = project(t);
  const r = cli(dir, ['verify', '--json'], { PATH: pathWithoutDocker(t) });
  const result = JSON.parse(r.out);
  assert.equal(result.passed, false);
  assert.notEqual(r.code, 0);
});

test('C1: plans pin the base, the parent is integration-only, and nodes are claimed once', (t) => {
  const dir = project(t);
  const base = git(dir, 'rev-parse', 'HEAD').stdout.trim();
  const parent = { ...JSON.parse(fs.readFileSync(path.join(dir, TASK), 'utf8')), id: 'titles', allowed_paths: ['src'] };
  assert.equal(parent.base_ref, 'HEAD');
  const plan = { schema_version: 1, task: parent, nodes: [{ task: { ...parent, id: 'a', allowed_paths: ['src/title.mjs'] } }, { task: { ...parent, id: 'b', allowed_paths: ['src/server.mjs'] } }] };
  const file = path.join(dir, '.git', 'plan.json');
  fs.writeFileSync(file, JSON.stringify(plan));
  assert.equal(cli(dir, ['approve-plan', file]).code, 0);
  const stored = (id) => path.join(dir, '.git/harness/plans/titles', `${id}.json`);
  assert.equal(JSON.parse(fs.readFileSync(stored('titles'), 'utf8')).base_ref, base, 'HEAD is pinned to a SHA at approval');
  assert.match(cli(dir, ['activate', stored('titles'), '--approved']).err, /harness integrate/);

  // A builder commits a weakened test and config, then tries to hide it behind a moved HEAD.
  git(dir, 'checkout', '-q', '-b', 'b/a');
  fs.writeFileSync(path.join(dir, 'acceptance/e2e.mjs'), 'console.log("ok")\n');
  fs.writeFileSync(path.join(dir, 'src/title.mjs'), FIX);
  git(dir, 'commit', '-qam', 'tamper');
  assert.match(cli(dir, ['activate', stored('a'), '--approved']).err, /protected paths already differ/);
  git(dir, 'checkout', '-q', 'main');
  git(dir, 'branch', 'b/b', 'main');
  assert.match(cli(dir, ['integrate', 'titles', '--branch', 'a=b/a', '--branch', 'b=b/b']).err, /no commits beyond the base/);
  git(dir, 'checkout', '-q', 'b/b');
  fs.appendFileSync(path.join(dir, 'src/server.mjs'), '// b\n');
  git(dir, 'commit', '-qam', 'b');
  git(dir, 'checkout', '-q', 'main');
  const r = cli(dir, ['integrate', 'titles', '--branch', 'a=b/a', '--branch', 'b=b/b', '--json'], { PATH: pathWithoutDocker(t) });
  const result = JSON.parse(r.out);
  assert.equal(result.status, 'blocked', 'the merged tampering is measured against the approved base');
  assert.ok(scope(result).details.includes('acceptance/e2e.mjs'));

  const w1 = path.join(dir, '.claude/worktrees/w1');
  const w2 = path.join(dir, '.claude/worktrees/w2');
  git(dir, 'worktree', 'add', '-q', '-b', 'w1', w1, base);
  git(dir, 'worktree', 'add', '-q', '-b', 'w2', w2, base);
  assert.equal(cli(w1, ['activate', stored('b'), '--approved']).code, 0);
  assert.match(cli(w2, ['activate', stored('b'), '--approved']).err, /already claimed/);
});

test('H1: a gate that cannot run blocks the stop instead of ending the turn silently', (t) => {
  const dir = project(t);
  cli(dir, ['activate', TASK]);
  fs.writeFileSync(path.join(dir, 'src/title.mjs'), FIX);
  const locks = path.join(dir, '.git/harness/locks');
  fs.mkdirSync(locks, { recursive: true });
  const key = fs.readdirSync(path.join(dir, '.git/harness/active'))[0].replace('.json', '');
  fs.writeFileSync(path.join(locks, `${key}.lock`), JSON.stringify({ pid: 999999999, at: 'stale' }));
  const env = { PATH: pathWithoutDocker(t) };
  const out = hook(stopEvent(dir), env).json;
  assert.equal(out.decision, 'block', 'a stale lock is taken over and the gate runs');
  assert.match(out.reason, /compose:e2e/);
});

test('M2 and M5: an explicit verify does not reuse another activation and resets nothing on failure', (t) => {
  const dir = project(t);
  const env = { PATH: pathWithoutDocker(t) };
  cli(dir, ['activate', TASK]);
  fs.writeFileSync(path.join(dir, 'src/title.mjs'), FIX);
  verify(dir, env);
  assert.equal(JSON.parse(cli(dir, ['status', '--json']).out).last.status, 'failed');
  cli(dir, ['deactivate']);
  cli(dir, ['activate', TASK]);
  assert.match(cli(dir, ['review-packet']).out, /No gate has run/, 'evidence from the earlier activation is not reused');
  for (let i = 0; i < 3; i += 1) hook(stopEvent(dir), env);
  const blocked = hook(stopEvent(dir), env).json;
  assert.match(blocked.systemMessage, /BLOCKED/);
  assert.match(blocked.systemMessage, /NOT verified/);
  const ctx = hook({ hook_event_name: 'SessionStart', cwd: dir }).json.hookSpecificOutput.additionalContext;
  assert.match(ctx, /budget is spent/);
});

test('H3: a task deactivated while its record is stale is not resurrected', async (t) => {
  const { updateActive, getActive, repoInfo } = await import('../plugins/harness/lib/state.mjs');
  const dir = project(t);
  cli(dir, ['activate', TASK]);
  const repo = repoInfo(dir);
  const stale = getActive(repo);
  cli(dir, ['deactivate']);
  assert.equal(updateActive(repo, stale.activation, () => ({ attempts: 9 })), null);
  assert.equal(getActive(repo), null);
});

test('H4 and M1: the audit reads real diffs under any diff config and skips prose', (t) => {
  const dir = project(t);
  const base = git(dir, 'rev-parse', 'HEAD').stdout.trim();
  git(dir, 'config', 'diff.mnemonicPrefix', 'true');
  fs.appendFileSync(path.join(dir, 'src/server.mjs'), [
    'let i = 0;', '++ i;', 'const bad = eval("1");',
    'const a = `Please select a file from ${process.cwd()}`;',
    'const b = "Select an item from the list: " + i;',
    'const c = /a/.exec(`${i}`);',
    '// eval(x) is mentioned in a comment',
    'const q = `SELECT * FROM notes WHERE id = ${i}`;',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'src/NOTES.md'), 'Never call eval(input).\n');
  fs.writeFileSync(path.join(dir, 'src/naïve.mjs'), 'export const f = new Function("return 1");\n');
  const found = auditDiff(dir, base).filter((f) => f.severity === 'high');
  const rules = found.map((f) => `${f.rule} ${f.where.replace(/:\d+$/, '')}`).sort();
  assert.deepEqual(rules, ['dynamic-exec src/naïve.mjs', 'dynamic-exec src/server.mjs', 'sql-interpolation src/server.mjs']);
});

test('compose lint: disabled healthchecks and volume driver options are rejected', () => {
  const model = { services: { app: { healthcheck: { disable: true } }, e2e: {} }, volumes: { data: { driver_opts: { o: 'bind', device: '/etc' } } } };
  const problems = lintModel(model, '/p', ['app', 'e2e']);
  assert.ok(problems.some((p) => p.includes('healthcheck')));
  assert.ok(problems.some((p) => p.includes('driver options')));
});
