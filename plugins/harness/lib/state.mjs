import fs from 'node:fs';
import path from 'node:path';
import { git, gitOut, fail, readJsonIfExists, writeJsonAtomic, sha256 } from './util.mjs';

const EVENT_LIMIT = 512 * 1024;

/**
 * Locate the checkout. Run state lives in the Git common directory: outside
 * every working tree, shared by all worktrees, and denied to the agent by the
 * guard's `.git/` rule.
 */
export function repoInfo(cwd) {
  const top = git(cwd, 'rev-parse', '--show-toplevel');
  if (top.code !== 0) return null;
  const root = fs.realpathSync(top.stdout.trim());
  const common = fs.realpathSync(path.resolve(root, gitOut(root, 'rev-parse', '--git-common-dir')));
  return { root, common, state: path.join(common, 'harness'), key: sha256(root).slice(0, 16) };
}

export function requireRepo(cwd) {
  return repoInfo(cwd) ?? fail(`${cwd} is not inside a Git repository`);
}

export const configPath = (repo) => path.join(repo.root, 'harness.json');
export const isAdopted = (repo) => fs.existsSync(configPath(repo));
const activePath = (repo) => path.join(repo.state, 'active', `${repo.key}.json`);

export function getActive(repo) {
  return readJsonIfExists(activePath(repo));
}

export function setActive(repo, record) {
  writeJsonAtomic(activePath(repo), record);
}

export function clearActive(repo) {
  const file = activePath(repo);
  const record = readJsonIfExists(file);
  if (!record) return null;
  const archive = path.join(repo.state, 'archive', `${record.task.id}-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  fs.renameSync(file, archive);
  return record;
}

export function newRunDir(repo, id) {
  const dir = path.join(repo.state, 'runs', id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function latestResult(repo, taskId) {
  const runs = path.join(repo.state, 'runs');
  if (!fs.existsSync(runs)) return null;
  for (const id of fs.readdirSync(runs).sort().reverse()) {
    const r = readJsonIfExists(path.join(runs, id, 'result.json'));
    if (r && (!taskId || r.task === taskId) && (!r.worktree || r.worktree === repo.root)) return r;
  }
  return null;
}

/** Append-only audit of hook and gate activity, trimmed to a bounded size. */
export function logEvent(repo, event) {
  try {
    const file = path.join(repo.state, 'events.jsonl');
    fs.mkdirSync(repo.state, { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), worktree: repo.root, ...event })}\n`);
    if (fs.statSync(file).size > EVENT_LIMIT) {
      const kept = fs.readFileSync(file, 'utf8').slice(-EVENT_LIMIT / 2);
      fs.writeFileSync(file, kept.slice(kept.indexOf('\n') + 1));
    }
  } catch {
    // The audit must never break a hook.
  }
}

/** One gate per repository at a time: Compose builds are heavy and share a daemon. */
export function withLock(repo, fn) {
  const lock = path.join(repo.state, 'gate.lock');
  fs.mkdirSync(repo.state, { recursive: true });
  const existing = readJsonIfExists(lock);
  if (existing) {
    let alive = true;
    try {
      process.kill(existing.pid, 0);
    } catch {
      alive = false;
    }
    if (alive) fail(`another gate is running (pid ${existing.pid}, since ${existing.at}); wait for it or inspect ${lock}`);
  }
  writeJsonAtomic(lock, { pid: process.pid, at: new Date().toISOString() });
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}
