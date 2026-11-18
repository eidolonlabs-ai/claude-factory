import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { git, gitOut, fail, sleep, readJsonIfExists, writeJsonAtomic, sha256 } from './util.mjs';

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
  return { root, common, state: path.join(common, 'factory'), key: sha256(root).slice(0, 16) };
}

export function requireRepo(cwd) {
  return repoInfo(cwd) ?? fail(`${cwd} is not inside a Git repository`);
}

export const configPath = (repo) => path.join(repo.root, 'factory.json');
export const isAdopted = (repo) => fs.existsSync(configPath(repo));
const activePath = (repo) => path.join(repo.state, 'active', `${repo.key}.json`);

export function getActive(repo) {
  return readJsonIfExists(activePath(repo));
}

export function setActive(repo, record) {
  writeJsonAtomic(activePath(repo), record);
}

/**
 * Change fields of the active record, re-reading it first. A gate runs for
 * minutes; if the task was deactivated or replaced meanwhile, nothing is written.
 */
export function updateActive(repo, activation, patch) {
  const current = getActive(repo);
  if (!current || current.activation !== activation) return null;
  const next = { ...current, ...patch(current) };
  setActive(repo, next);
  return next;
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

/**
 * Latest result for this worktree. With an activation id, only results from
 * that activation count: an older pass for the same task id is not evidence.
 */
export function latestResult(repo, activation) {
  const runs = path.join(repo.state, 'runs');
  if (!fs.existsSync(runs)) return null;
  for (const id of fs.readdirSync(runs).sort().reverse()) {
    const r = readJsonIfExists(path.join(runs, id, 'result.json'));
    if (r && r.worktree === repo.root && (activation === undefined || r.activation === activation)) return r;
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

/**
 * One gate per worktree at a time. Worktrees gate concurrently: each run has
 * its own Compose project. `waitSeconds` lets a hook queue behind a running
 * gate instead of failing.
 */
export function withLock(repo, fn, waitSeconds = 0) {
  const lock = path.join(repo.state, 'locks', `${repo.key}.lock`);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + waitSeconds * 1000;
  for (;;) {
    const tmp = `${lock}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    let acquired = false;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      fs.linkSync(tmp, lock);
      acquired = true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    if (acquired) break;
    let holder = null;
    try {
      holder = JSON.parse(fs.readFileSync(lock, 'utf8'));
      if (!holder || !Number.isInteger(holder.pid) || holder.pid <= 0) throw new Error('invalid lock');
      process.kill(holder.pid, 0);
    } catch (e) {
      if (e?.code === 'EPERM') {
        // Alive process owned by another UID
      } else {
        fs.rmSync(lock, { force: true }); // unreadable, invalid, or its process is gone
        continue;
      }
    }
    if (Date.now() >= deadline) fail(`another gate is running in this worktree (pid ${holder.pid}, since ${holder.at})`);
    sleep(1000);
  }
  try {
    return fn();
  } finally {
    try {
      if (JSON.parse(fs.readFileSync(lock, 'utf8')).pid === process.pid) fs.rmSync(lock, { force: true });
    } catch {
      // already gone
    }
  }
}
