// Regression cases from the independent gate review of e94fb5c. These run
// without Docker: each must fail before the stack would be booted.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { activate, acceptanceFor, withRecords, project, cli, hook, git, pathWithoutDocker, CLI } from './helpers.mjs';
import { auditDiff } from '../plugins/factory/lib/audit.mjs';
import { lintModel } from '../plugins/factory/lib/compose.mjs';

const TASK = 'tasks/trim-note-titles.json';
const FIX = "export const normalizeTitle = (t) => (typeof t === 'string' && t.trim() ? t.trim() : null);\n";
const verify = (dir, env) => JSON.parse(cli(dir, ['verify', '--json'], env).out);
const scope = (r) => r.checks.find((c) => c.id === 'scope');
const stopEvent = (dir) => ({ hook_event_name: 'Stop', cwd: dir, permission_mode: 'default' });

test('C2: index flags and replace refs cannot hide a tampered acceptance test', (t) => {
  const dir = project(t);
  activate(dir);
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
  activate(dir2);
  fs.writeFileSync(path.join(dir2, 'acceptance/e2e.mjs'), 'console.log("ok")\n');
  git(dir2, 'commit', '-qam', 'tamper');
  git(dir2, 'replace', base, 'HEAD');
  r = verify(dir2);
  assert.equal(r.status, 'blocked', 'git replace must not move the base');
});

test('C4: nested repositories and new ignore rules fail scope', (t) => {
  const dir = project(t);
  activate(dir);
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
  fs.writeFileSync(file, JSON.stringify(withRecords(plan)));
  assert.equal(cli(dir, ['approve-plan', file]).code, 0);
  const stored = (id) => path.join(dir, '.git/factory/plans/titles', `${id}.json`);
  assert.equal(JSON.parse(fs.readFileSync(stored('titles'), 'utf8')).base_ref, base, 'HEAD is pinned to a SHA at approval');
  assert.match(cli(dir, ['activate', stored('titles'), '--approved']).err, /factory integrate/);

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
  activate(dir);
  fs.writeFileSync(path.join(dir, 'src/title.mjs'), FIX);
  const locks = path.join(dir, '.git/factory/locks');
  fs.mkdirSync(locks, { recursive: true });
  const key = fs.readdirSync(path.join(dir, '.git/factory/active'))[0].replace('.json', '');
  fs.writeFileSync(path.join(locks, `${key}.lock`), JSON.stringify({ pid: 999999999, at: 'stale' }));
  const env = { PATH: pathWithoutDocker(t) };
  const out = hook(stopEvent(dir), env).json;
  assert.equal(out.decision, 'block', 'a stale lock is taken over and the gate runs');
  assert.match(out.reason, /compose:e2e/);
});

test('M2 and M5: an explicit verify does not reuse another activation and resets nothing on failure', (t) => {
  const dir = project(t);
  const env = { PATH: pathWithoutDocker(t) };
  activate(dir);
  fs.writeFileSync(path.join(dir, 'src/title.mjs'), FIX);
  verify(dir, env);
  assert.equal(JSON.parse(cli(dir, ['status', '--json']).out).last.status, 'failed');
  cli(dir, ['deactivate']);
  activate(dir);
  assert.match(cli(dir, ['review-packet']).out, /No gate has run/, 'evidence from the earlier activation is not reused');
  for (let i = 0; i < 3; i += 1) hook(stopEvent(dir), env);
  const blocked = hook(stopEvent(dir), env).json;
  assert.match(blocked.systemMessage, /BLOCKED/);
  assert.match(blocked.systemMessage, /NOT verified/);
  const ctx = hook({ hook_event_name: 'SessionStart', cwd: dir }).json.hookSpecificOutput.additionalContext;
  assert.match(ctx, /budget is spent/);
});

test('H3: a task deactivated while its record is stale is not resurrected', async (t) => {
  const { updateActive, getActive, repoInfo } = await import('../plugins/factory/lib/state.mjs');
  const dir = project(t);
  activate(dir);
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

test('integrate enforces ancestor lineage, per-node allowed_paths, and cleans active state on conflict', (t) => {
  const dir = project(t);
  const base = git(dir, 'rev-parse', 'HEAD').stdout.trim();
  const parent = { ...JSON.parse(fs.readFileSync(path.join(dir, TASK), 'utf8')), id: 'titles', allowed_paths: ['src'], base_ref: base };
  const plan = {
    schema_version: 1,
    task: parent,
    nodes: [
      { task: { ...parent, id: 'a', allowed_paths: ['src/title.mjs'] } },
      { task: { ...parent, id: 'b', allowed_paths: ['src/server.mjs'] } },
    ],
  };
  const planFile = path.join(dir, '.git/plan.json');
  fs.writeFileSync(planFile, JSON.stringify(withRecords(plan)));
  assert.equal(cli(dir, ['approve-plan', planFile]).code, 0);

  // Unrelated orphan branch not descended from base is rejected.
  git(dir, 'checkout', '-q', '--orphan', 'b/orphan');
  fs.writeFileSync(path.join(dir, 'src/title.mjs'), '// orphan\n');
  git(dir, 'add', 'src/title.mjs');
  git(dir, 'commit', '-q', '-m', 'orphan');
  git(dir, 'checkout', '-q', '-b', 'b/b', base);
  fs.appendFileSync(path.join(dir, 'src/server.mjs'), '// b\n');
  git(dir, 'commit', '-qam', 'b');
  git(dir, 'checkout', '-q', 'main');
  assert.match(cli(dir, ['integrate', 'titles', '--branch', 'a=b/orphan', '--branch', 'b=b/b']).err, /not descended/);

  // Cross-slice edit (node a edits node b's src/server.mjs) fails scope before booting Compose.
  git(dir, 'checkout', '-q', '-b', 'b/a', base);
  fs.appendFileSync(path.join(dir, 'src/server.mjs'), '// stolen\n');
  git(dir, 'commit', '-qam', 'a cross-slice');
  git(dir, 'checkout', '-q', '-b', 'b/b2', base);
  fs.writeFileSync(path.join(dir, 'src/title.mjs'), FIX);
  git(dir, 'commit', '-qam', 'b cross-slice');
  git(dir, 'checkout', '-q', 'main');
  const cross = JSON.parse(cli(dir, ['integrate', 'titles', '--branch', 'a=b/a', '--branch', 'b=b/b2', '--json'], { PATH: pathWithoutDocker(t) }).out);
  assert.equal(cross.status, 'failed');
  assert.ok(scope(cross).details.some((d) => d.includes('a: src/server.mjs')));

  // Merge conflict aborts cleanly and removes the orphaned active record for the retained integration worktree.
  git(dir, 'checkout', '-q', '-b', 'b/c1', base);
  fs.writeFileSync(path.join(dir, 'src/title.mjs'), '// branch 1\n');
  git(dir, 'commit', '-qam', 'c1');
  git(dir, 'checkout', '-q', '-b', 'b/c2', base);
  fs.writeFileSync(path.join(dir, 'src/title.mjs'), '// branch 2\n');
  git(dir, 'commit', '-qam', 'c2');
  git(dir, 'checkout', '-q', 'main');
  const beforeActive = fs.readdirSync(path.join(dir, '.git/factory/active')).length;
  const conflict = cli(dir, ['integrate', 'titles', '--branch', 'a=b/c1', '--branch', 'b=b/c2']);
  assert.notEqual(conflict.code, 0);
  assert.match(conflict.err, /conflicted/);
  assert.equal(fs.readdirSync(path.join(dir, '.git/factory/active')).length, beforeActive);
});

test('SubagentStop resolves worktree from parent cwd via agent_id and withLock recovers invalid pid locks', async (t) => {
  const { withLock, repoInfo } = await import('../plugins/factory/lib/state.mjs');
  const dir = project(t);
  const repo = repoInfo(dir);
  const locks = path.join(repo.state, 'locks');
  fs.mkdirSync(locks, { recursive: true });
  fs.writeFileSync(path.join(locks, `${repo.key}.lock`), JSON.stringify({ at: 'corrupt-no-pid' }));
  assert.equal(withLock(repo, () => 'acquired', 0), 'acquired');

  const base = git(dir, 'rev-parse', 'HEAD').stdout.trim();
  const parent = { ...JSON.parse(fs.readFileSync(path.join(dir, TASK), 'utf8')), id: 'sub', allowed_paths: ['src'], base_ref: base };
  const planFile = path.join(dir, '.git/sub-plan.json');
  fs.writeFileSync(planFile, JSON.stringify(withRecords({ schema_version: 1, task: parent, nodes: [{ task: { ...parent, id: 'n1', allowed_paths: ['src/title.mjs'] } }] })));
  assert.equal(cli(dir, ['approve-plan', planFile]).code, 0);
  const wt = path.join(dir, '.claude/worktrees/agent-xyz123');
  git(dir, 'worktree', 'add', '-q', '-b', 'b/sub', wt, base);
  assert.equal(cli(wt, ['activate', path.join(dir, '.git/factory/plans/sub/n1.json'), '--approved']).code, 0);
  fs.writeFileSync(path.join(wt, 'src/title.mjs'), 'broken();\n');
  const out = hook({ hook_event_name: 'SubagentStop', agent_type: 'factory:factory-builder', agent_id: 'xyz123', cwd: dir, permission_mode: 'default' }, { PATH: pathWithoutDocker(t) }).json;
  assert.equal(out?.decision, 'block');
  assert.match(out?.reason, /compose:e2e/);
});

test('managedRun preserves attempt budget across environmental failures and enforces run_seconds', async (t) => {
  const { spawn } = await import('node:child_process');
  const os = await import('node:os');
  const dir = project(t);
  const cfgPath = path.join(dir, 'factory.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  fs.writeFileSync(cfgPath, JSON.stringify({ ...cfg, limits: { attempts: 2, run_seconds: 2, agent_seconds: 10 } }));
  git(dir, 'commit', '-qam', 'set limits');

  const bin = fs.mkdtempSync(path.join(os.default.tmpdir(), 'fake-managed-'));
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  const countFile = path.join(bin, 'count');
  fs.writeFileSync(countFile, '0');
  const fakeClaude = path.join(bin, 'claude');
  fs.writeFileSync(fakeClaude, `#!/usr/bin/env node
const fs = require('fs');
const n = Number(fs.readFileSync(${JSON.stringify(countFile)}, 'utf8')) + 1;
fs.writeFileSync(${JSON.stringify(countFile)}, String(n));
if (n === 1) fs.writeFileSync('src/title.mjs', 'export const normalizeTitle = (t) => t;\\n');
setTimeout(() => console.log(JSON.stringify({ total_cost_usd: 0.01 })), n === 1 ? 50 : 2500);
`);
  fs.chmodSync(fakeClaude, 0o755);

  const fakeDocker = path.join(bin, 'docker');
  fs.writeFileSync(fakeDocker, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'compose' && args[1] === 'version') { console.log('2.20.0'); process.exit(0); }
if (args[0] === 'info') { console.log('26.0.0'); process.exit(0); }
if (args[0] === 'ps' && args.includes('--no-trunc')) { process.exit(1); }
if (args[0] === 'ps' && args.includes('-aq')) { process.exit(0); }
if (args.includes('config')) { console.log(JSON.stringify({ services: { app: { healthcheck: { test: ['CMD', 'true'] } }, e2e: {} } })); process.exit(0); }
process.exit(0);
`);
  fs.chmodSync(fakeDocker, 0o755);

  const taskPath = path.join(dir, '.git/t.json');
  fs.copyFileSync(path.join(dir, TASK), taskPath);
  const accPath = acceptanceFor(dir, taskPath);
  t.after(() => fs.rmSync(accPath, { force: true }));
  const r = cli(dir, ['run', taskPath, '--acceptance', accPath, '--json'], {
    CLAUDE_FACTORY_CLAUDE_BIN: fakeClaude,
    PATH: `${bin}:${pathWithoutDocker(t)}`,
  });
  const result = JSON.parse(r.out);
  assert.equal(result.environmental, true);
  assert.equal(result.attempts, 1, 'environmental failures do not consume the candidate attempt budget');
  assert.ok(Number(fs.readFileSync(countFile, 'utf8')) <= 2, 'run_seconds caps follow-up iterations');

  // Verify claimApproved locking protects parallel node activations across worktrees.
  const base = git(dir, 'rev-parse', 'HEAD').stdout.trim();
  const parent = { ...JSON.parse(fs.readFileSync(path.join(dir, TASK), 'utf8')), id: 'par', allowed_paths: ['src'], base_ref: base };
  const pf = path.join(dir, '.git/par.json');
  fs.writeFileSync(pf, JSON.stringify(withRecords({
    schema_version: 1,
    task: parent,
    nodes: [
      { task: { ...parent, id: 'p1', allowed_paths: ['src/title.mjs'] } },
      { task: { ...parent, id: 'p2', allowed_paths: ['src/server.mjs'] } },
    ],
  })));
  assert.equal(cli(dir, ['approve-plan', pf]).code, 0);
  const w1 = path.join(dir, '.claude/worktrees/par1');
  const w2 = path.join(dir, '.claude/worktrees/par2');
  git(dir, 'worktree', 'add', '-q', '-b', 'b/p1', w1, base);
  git(dir, 'worktree', 'add', '-q', '-b', 'b/p2', w2, base);
  const runAsync = (cwd, taskId) => new Promise((resolve) => {
    const child = spawn('node', [CLI, 'activate', path.join(dir, '.git/factory/plans/par', `${taskId}.json`), '--approved'], { cwd, encoding: 'utf8' });
    child.on('close', (code) => resolve(code));
  });
  const codes = await Promise.all([runAsync(w1, 'p1'), runAsync(w2, 'p2')]);
  assert.deepEqual(codes, [0, 0]);
  const savedPlan = JSON.parse(fs.readFileSync(path.join(dir, '.git/factory/plans/par.json'), 'utf8'));
  assert.equal(Object.keys(savedPlan.claims).length, 2, 'concurrent claims do not overwrite each other');
});
