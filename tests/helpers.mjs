import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { draftAcceptance } from '../plugins/factory/lib/acceptance.mjs';

export const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const PLUGIN = path.join(REPO, 'plugins', 'factory');
export const CLI = path.join(PLUGIN, 'scripts', 'factory.mjs');
export const HOOK = path.join(PLUGIN, 'scripts', 'hook.mjs');

const GIT = ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid'];
export const git = (cwd, ...args) => spawnSync('git', [...GIT, ...args], { cwd, encoding: 'utf8' });

/** A committed copy of the notes demo app in a temporary directory. */
export function project(t, { adopt = true } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'factory-test-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(path.join(REPO, 'examples', 'notes-app'), dir, { recursive: true });
  if (!adopt) fs.rmSync(path.join(dir, 'factory.json'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'baseline');
  return dir;
}

export function cli(cwd, args, env = {}) {
  const r = spawnSync('node', [CLI, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

export function hook(event, env = {}) {
  const r = spawnSync('node', [HOOK], { input: JSON.stringify(event), encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: r.status, json: r.stdout.trim() ? JSON.parse(r.stdout) : null, err: r.stderr };
}

/** A PATH with git and node but no docker, to exercise NOT_RUN handling. */
export function pathWithoutDocker(t) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-bin-'));
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  for (const tool of ['git', 'node']) {
    const found = spawnSync('which', [tool], { encoding: 'utf8' }).stdout.trim();
    fs.symlinkSync(found, path.join(bin, tool));
  }
  return bin;
}

/** What an owner does after reviewing a draft: accept the proposed mapping, optionally adding manual observations. */
export function acceptanceFor(dir, task, edit = (r) => r) {
  const r = cli(dir, ['prepare', task]);
  if (r.code !== 0) throw new Error(r.err);
  const record = edit({ ...JSON.parse(r.out), unresolved_decisions: [] });
  const file = path.join(os.tmpdir(), `acceptance-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(record));
  return file;
}

export function activate(dir, task = 'tasks/trim-note-titles.json', edit) {
  return cli(dir, ['activate', task, '--acceptance', acceptanceFor(dir, task, edit)]);
}

/** Give a plan's parent and nodes reviewed records that accept the proposed mapping. */
export function withRecords(plan) {
  const rec = (task) => ({ ...draftAcceptance(task, ''), unresolved_decisions: [] });
  return { ...plan, acceptance: plan.acceptance ?? rec(plan.task), nodes: plan.nodes.map((n) => ({ acceptance: rec(n.task), ...n })) };
}
