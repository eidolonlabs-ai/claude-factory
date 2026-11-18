import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { activate, acceptanceFor, withRecords, project, cli, hook, git, pathWithoutDocker, PLUGIN, REPO } from './helpers.mjs';

const TASK = 'tasks/trim-note-titles.json';
const event = (dir, name, tool, tool_input, extra = {}) => ({ hook_event_name: name, cwd: dir, permission_mode: 'default', tool_name: tool, tool_input, ...extra });

test('hooks stay silent outside adopted repositories', (t) => {
  const dir = project(t, { adopt: false });
  assert.equal(hook(event(dir, 'PreToolUse', 'Write', { file_path: path.join(dir, '.env') })).json, null);
  assert.equal(hook(event(dir, 'SessionStart')).json, null);
  assert.equal(hook(event(dir, 'Stop')).json, null);
});

test('activation freezes the task and the guard enforces its scope', (t) => {
  const dir = project(t);
  assert.match(hook(event(dir, 'SessionStart')).json.hookSpecificOutput.additionalContext, /no task is active/);
  assert.equal(hook(event(dir, 'PreToolUse', 'Edit', { file_path: path.join(dir, 'src/server.mjs') })).json, null, 'no task: ordinary edits pass');

  const a = activate(dir);
  assert.equal(a.code, 0, a.err);
  assert.equal(activate(dir).code, 2, 'a second activation is refused');
  assert.ok(fs.existsSync(path.join(dir, '.git', 'factory', 'active')), 'state lives in the Git common directory');

  const deny = (tool, input) => hook(event(dir, 'PreToolUse', tool, input)).json?.hookSpecificOutput.permissionDecision;
  assert.equal(deny('Edit', { file_path: path.join(dir, 'src/title.mjs') }), undefined);
  assert.equal(deny('Edit', { file_path: 'src/server.mjs' }), 'deny');
  assert.equal(deny('Write', { file_path: path.join(dir, 'acceptance/e2e.mjs') }), 'deny');
  assert.equal(deny('Write', { file_path: path.join(dir, 'factory.json') }), 'deny');
  assert.equal(deny('Bash', { command: 'sed -i "" s/a/b/ compose.yaml' }), 'deny');
  assert.equal(deny('Bash', { command: 'git push origin main' }), 'deny');
  assert.equal(deny('Bash', { command: 'git reset --hard HEAD' }), 'ask');
  assert.equal(hook(event(dir, 'PreToolUse', 'Bash', { command: 'git reset --hard HEAD' }, { permission_mode: 'bypassPermissions' })).json.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(hook(event(dir, 'SessionStart')).json.hookSpecificOutput.additionalContext, /trim-note-titles/);

  const s = JSON.parse(cli(dir, ['status', '--json']).out);
  assert.equal(s.active.id, 'trim-note-titles');
  assert.equal(cli(dir, ['deactivate']).code, 0);
  assert.equal(JSON.parse(cli(dir, ['status', '--json']).out).active, null);
});

test('activation refuses unready tasks and dirty protected paths', (t) => {
  const dir = project(t);
  const write = (name, patch) => {
    const task = { ...JSON.parse(fs.readFileSync(path.join(dir, TASK), 'utf8')), ...patch };
    fs.writeFileSync(path.join(dir, name), JSON.stringify(task));
    return name;
  };
  assert.match(cli(dir, ['activate', write('t1.json', { base_ref: '<approved Git commit>' })]).err, /placeholder/);
  assert.match(cli(dir, ['activate', write('t2.json', { allowed_paths: ['acceptance'] })]).err, /protected/);
  assert.match(cli(dir, ['activate', write('t3.json', { allowed_paths: ['docs'] })]).err, /editable_paths/);
  assert.match(cli(dir, ['activate', write('t4.json', { base_ref: 'no-such-ref' })]).err, /does not resolve/);
  fs.appendFileSync(path.join(dir, 'acceptance/e2e.mjs'), '\n// weakened\n');
  assert.match(activate(dir).err, /protected paths already differ/);
});

test('NOT_RUN is never PASS: an unreachable Docker fails the gate', (t) => {
  const dir = project(t);
  activate(dir);
  fs.writeFileSync(path.join(dir, 'src/title.mjs'), "export const normalizeTitle = (t) => (typeof t === 'string' && t.trim() ? t.trim() : null);\n");
  const r = cli(dir, ['verify', '--json'], { PATH: pathWithoutDocker(t) });
  assert.equal(r.code, 1);
  const result = JSON.parse(r.out);
  assert.equal(result.passed, false);
  assert.equal(result.checks.find((c) => c.id === 'scope').status, 'PASS');
  assert.equal(result.checks.find((c) => c.id === 'compose:e2e').status, 'NOT_RUN');
  assert.ok(fs.existsSync(path.join(result.evidence, 'result.json')));
  for (const key of ['schema_version', 'run_id', 'milestone', 'role', 'engine', 'status', 'passed', 'checks']) assert.ok(key in result, `result has ${key}`);
});

test('the gate fails scope and blocks on protected changes before booting anything', (t) => {
  const dir = project(t);
  activate(dir);
  fs.writeFileSync(path.join(dir, 'src/extra.mjs'), 'export {};\n');
  let result = JSON.parse(cli(dir, ['verify', '--json']).out);
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.checks.find((c) => c.id === 'scope').details, ['src/extra.mjs']);
  assert.equal(result.checks.find((c) => c.id === 'compose:e2e').status, 'NOT_RUN');
  fs.rmSync(path.join(dir, 'src/extra.mjs'));
  fs.appendFileSync(path.join(dir, 'acceptance/e2e.mjs'), '\n');
  result = JSON.parse(cli(dir, ['verify', '--json']).out);
  assert.equal(result.status, 'blocked');
  git(dir, 'checkout', '--', 'acceptance/e2e.mjs');
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'factory.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'factory.json'), JSON.stringify({ ...cfg, checks: [] }));
  result = JSON.parse(cli(dir, ['verify', '--json']).out);
  assert.equal(result.status, 'blocked', 'a weakened factory.json is a protected change');
});

test('the Stop hook blocks a failing candidate within its attempt budget', (t) => {
  const dir = project(t);
  const env = { PATH: pathWithoutDocker(t) };
  activate(dir);
  assert.equal(hook(event(dir, 'Stop'), env).json, null, 'nothing changed: nothing to verify');
  fs.writeFileSync(path.join(dir, 'src/title.mjs'), 'export const normalizeTitle = (t) => t;\n');
  for (let i = 1; i <= 3; i += 1) {
    const out = hook(event(dir, 'Stop'), env).json;
    assert.equal(out.decision, 'block');
    assert.match(out.reason, new RegExp(`Attempt ${i} of 3`));
  }
  assert.match(hook(event(dir, 'Stop'), env).json.systemMessage, /BLOCKED/);
  assert.equal(hook(event(dir, 'Stop'), { ...env, CLAUDE_FACTORY_MANAGED: '1' }).json, null, 'managed runs are gated by their controller');
});

test('plans validate ownership and gate plan-approved activation', (t) => {
  const dir = project(t);
  const parent = { ...JSON.parse(fs.readFileSync(path.join(dir, TASK), 'utf8')), allowed_paths: ['src'] };
  const node = (id, paths) => ({ ...parent, id, allowed_paths: paths });
  const save = (plan) => {
    fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(withRecords(plan)));
    return cli(dir, ['approve-plan', 'plan.json']);
  };
  const base = { schema_version: 1, task: parent };
  assert.match(save({ ...base, nodes: [{ task: node('a', ['src/title.mjs']) }, { task: node('b', ['src']) }] }).err, /overlapping paths/);
  assert.match(save({ ...base, nodes: [{ task: node('a', ['docs']) }] }).err, /outside the parent/);
  assert.match(save({ ...base, nodes: [{ task: node('a', ['src/title.mjs']), depends_on: ['b'] }, { task: node('b', ['src/server.mjs']), depends_on: ['a'] }] }).err, /cycle/);
  fs.writeFileSync(path.join(dir, 'rogue.json'), JSON.stringify(node('rogue', ['src/server.mjs'])));
  assert.match(cli(dir, ['activate', 'rogue.json', '--approved']).err, /not on record/);
  const ok = save({ ...base, nodes: [{ task: node('a', ['src/title.mjs']) }, { task: node('b', ['src/server.mjs']) }] });
  assert.equal(ok.code, 0, ok.err);
  fs.rmSync(path.join(dir, 'plan.json'));
  fs.rmSync(path.join(dir, 'rogue.json'));
  const approved = path.join(dir, '.git', 'factory', 'plans', parent.id, 'a.json');
  assert.equal(cli(dir, ['activate', approved, '--approved']).code, 0);
});

test('setup previews, applies and never overwrites', (t) => {
  const dir = project(t, { adopt: false });
  git(dir, 'add', '-A');
  assert.match(cli(dir, ['setup']).out, /Nothing was written/);
  assert.ok(!fs.existsSync(path.join(dir, 'factory.json')));
  assert.equal(cli(dir, ['setup', '--apply']).code, 0);
  assert.ok(fs.existsSync(path.join(dir, '.claude/settings.json')));
  fs.writeFileSync(path.join(dir, 'factory.json'), '{"mine":true}');
  cli(dir, ['setup', '--apply']);
  assert.equal(fs.readFileSync(path.join(dir, 'factory.json'), 'utf8'), '{"mine":true}');
});

test('the review packet carries the task and the diff, and flags missing evidence', (t) => {
  const dir = project(t);
  activate(dir);
  fs.writeFileSync(path.join(dir, 'src/title.mjs'), 'export const normalizeTitle = (t) => t.trim();\n');
  const packet = cli(dir, ['review-packet']).out;
  assert.match(packet, /Acceptance criteria/);
  assert.match(packet, /No gate has run/);
  assert.match(packet, /\+export const normalizeTitle/);
});

test('the packaged plugin is self-consistent', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN, '.claude-plugin/plugin.json'), 'utf8'));
  const market = JSON.parse(fs.readFileSync(path.join(REPO, '.claude-plugin/marketplace.json'), 'utf8'));
  assert.equal(market.plugins[0].name, manifest.name);
  assert.ok(fs.existsSync(path.join(REPO, market.plugins[0].source)));
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.ok(!/^(claude|anthropic)/.test(manifest.name), 'reserved plugin name prefix');
  const hooks = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'hooks/hooks.json'), 'utf8')).hooks;
  assert.deepEqual(Object.keys(hooks).sort(), ['PreToolUse', 'SessionStart', 'Stop', 'SubagentStop']);
  for (const dir of ['skills', 'agents']) {
    for (const file of fs.readdirSync(path.join(PLUGIN, dir), { recursive: true }).filter((f) => f.endsWith('.md'))) {
      const text = fs.readFileSync(path.join(PLUGIN, dir, file), 'utf8');
      assert.match(text, /^---\nname: [a-z-]+\ndescription: .+\n/, `${file} frontmatter`);
      assert.ok(!/^model:/m.test(text), `${file} must not pin a model`);
    }
  }
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(PLUGIN, 'schemas/guard-cases.json'), 'utf8')),
    JSON.parse(fs.readFileSync(path.join(REPO, 'contract/guard-cases.json'), 'utf8')),
    'the packaged guard cases match the family contract',
  );
});

test('acceptance records: every criterion must be mapped before activation', (t) => {
  const dir = project(t);
  const TASK_FILE = 'tasks/trim-note-titles.json';
  assert.match(cli(dir, ['activate', TASK_FILE]).err, /acceptance record is required/);
  const draft = JSON.parse(cli(dir, ['prepare', TASK_FILE]).out);
  assert.equal(draft.criteria.length, 2);
  const tryRecord = (record) => {
    const f = path.join(dir, '.git', 'r.json');
    fs.writeFileSync(f, JSON.stringify(record));
    return cli(dir, ['activate', TASK_FILE, '--acceptance', f]).err;
  };
  assert.match(tryRecord(draft), /unresolved decisions remain/);
  const ready = { ...draft, unresolved_decisions: [] };
  assert.match(tryRecord({ ...ready, criteria: ready.criteria.slice(1) }), /mapped 0 times/);
  assert.match(tryRecord({ ...ready, criteria: ready.criteria.map((c) => ({ ...c, checks: [] })) }), /nothing proves it/);
  assert.match(tryRecord({ ...ready, criteria: ready.criteria.map((c) => ({ ...c, checks: ['no-such-check'] })) }), /unknown check/);
  assert.match(tryRecord({ ...ready, task_sha256: '0'.repeat(64) }), /does not match this task/);
  assert.match(tryRecord({ ...ready, base: '0'.repeat(40) }), /regenerate/);
  assert.equal(tryRecord(ready), '');
});

test('acceptance records: a manual observation is bound to the candidate it was made on', async (t) => {
  const { getActive, updateActive, repoInfo } = await import('../plugins/factory/lib/state.mjs');
  const { pendingManual } = await import('../plugins/factory/lib/acceptance.mjs');
  const dir = project(t);
  const r = activate(dir, 'tasks/trim-note-titles.json', (rec) => ({ ...rec, criteria: rec.criteria.map((c, i) => (i === 0 ? { ...c, manual: ['The page shows the trimmed title after a reload'] } : c)) }));
  assert.equal(r.code, 0, r.err);
  assert.match(cli(dir, ['evidence', 'c2', '--note', 'x']).err, /no manual requirement/);
  assert.match(cli(dir, ['evidence', 'c1']).err, /--note/);
  let s = JSON.parse(cli(dir, ['status', '--json']).out);
  assert.equal(s.pending_manual.length, 1);
  assert.equal(cli(dir, ['evidence', 'c1', '--note', 'Saw "hello" in the list after reloading']).code, 0);
  s = JSON.parse(cli(dir, ['status', '--json']).out);
  assert.equal(s.pending_manual.length, 0);
  fs.writeFileSync(path.join(dir, 'src/title.mjs'), 'export const normalizeTitle = (x) => x;\n');
  s = JSON.parse(cli(dir, ['status', '--json']).out);
  assert.equal(s.pending_manual.length, 1, 'the observation does not carry over to a changed candidate');
  assert.match(cli(dir, ['review-packet']).out, /manual: The page shows/);
  const repo = repoInfo(dir);
  assert.ok(pendingManual(getActive(repo).acceptance, getActive(repo).evidence, 'other').length === 1);
  assert.ok(updateActive);
});
