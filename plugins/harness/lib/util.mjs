import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const LOG_LIMIT = 256 * 1024;

export class HarnessError extends Error {}

export function fail(message) {
  throw new HarnessError(message);
}

/** Run a program without a shell. Output is captured and returned whole. */
export function sh(cmd, args = [], opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    input: opts.input,
    encoding: 'utf8',
    timeout: opts.timeout ? opts.timeout * 1000 : undefined,
    maxBuffer: 64 * 1024 * 1024,
    killSignal: 'SIGKILL',
  });
  const timedOut = r.error?.code === 'ETIMEDOUT';
  const missing = r.error?.code === 'ENOENT';
  return {
    code: missing ? 127 : timedOut ? 124 : (r.status ?? 1),
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? (r.error ? String(r.error.message) : ''),
    timedOut,
    missing,
  };
}

// Replacement refs can make Git report a different
// history than the one on disk; the harness always reads the real one.
const GIT_ENV = { GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0' };

export function git(cwd, ...args) {
  return sh('git', ['-c', 'core.quotepath=off', ...args], { cwd, env: { ...process.env, ...GIT_ENV } });
}

/** Block the thread briefly; hooks and the CLI are short-lived synchronous processes. */
export function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function gitOut(cwd, ...args) {
  const r = git(cwd, ...args);
  if (r.code !== 0) fail(`git ${args.join(' ')} failed: ${r.stderr.trim() || r.stdout.trim()}`);
  return r.stdout.replace(/\n$/, '');
}

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

/** Stable JSON so digests do not depend on key order. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function digest(value) {
  return sha256(canonical(value));
}

export function readJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    fail(`cannot read ${file}: ${e.code ?? e.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    fail(`${file} is not valid JSON: ${e.message}`);
  }
}

export function readJsonIfExists(file) {
  return fs.existsSync(file) ? readJson(file) : null;
}

export function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

export function writeJsonAtomic(file, value) {
  writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Keep the tail of long output: failures are usually at the end. */
export function bounded(text, limit = LOG_LIMIT) {
  if (text.length <= limit) return text;
  return `[... ${text.length - limit} bytes omitted ...]\n${text.slice(-limit)}`;
}

export function tail(text, lines = 25) {
  return text.trimEnd().split('\n').slice(-lines).join('\n');
}

export function runId() {
  const t = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  return `${t}-${randomBytes(3).toString('hex')}`;
}

export function now() {
  return new Date().toISOString();
}
