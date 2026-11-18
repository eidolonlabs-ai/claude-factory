import { fail, readJson, git } from './util.mjs';
import { coveredBy, protectedPaths } from './policy.mjs';
import { configPath } from './state.mjs';

const SERVICE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const TASK_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\\)(?!.*(?:^|\/)\.git(?:\/|$))[^/]+(?:\/[^/]+)*$/;

const isStrings = (v, min = 0) => Array.isArray(v) && v.length >= min && v.every((s) => typeof s === 'string' && s.length > 0);

function unknownKeys(obj, allowed, where, errors) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) errors.push(`${where}: unknown field "${k}"`);
}

/** Validate harness.json. The format is the family's v3 config (see schemas/config.schema.json). */
export function validateConfig(c) {
  const e = [];
  if (!c || typeof c !== 'object' || Array.isArray(c)) return ['harness.json must be an object'];
  unknownKeys(c, ['$schema', 'schema_version', 'checks', 'limits', 'policy', 'compose'], 'harness.json', e);
  if (c.schema_version !== 3) e.push('schema_version must be 3 (Compose acceptance is required)');
  if (!Array.isArray(c.checks)) e.push('checks must be an array (it may be empty)');
  else {
    const names = new Set();
    c.checks.forEach((k, i) => {
      if (!k || typeof k.name !== 'string' || !k.name) e.push(`checks[${i}].name is required`);
      else if (names.has(k.name) || k.name.startsWith('compose:')) e.push(`checks[${i}].name "${k.name}" is duplicated or reserved`);
      else names.add(k.name);
      if (!isStrings(k?.argv, 1)) e.push(`checks[${i}].argv must be a non-empty array of strings (no shell)`);
      if (k?.timeout_seconds !== undefined && !(Number.isInteger(k.timeout_seconds) && k.timeout_seconds > 0)) e.push(`checks[${i}].timeout_seconds must be a positive integer`);
    });
  }
  const p = c.policy;
  if (!p || !isStrings(p.editable_paths, 1) || !isStrings(p.protected_paths, 1)) {
    e.push('policy.editable_paths and policy.protected_paths must each list at least one path');
  }
  const k = c.compose;
  if (!k || !isStrings(k.files, 1) || !isStrings(k.services, 1) || typeof k.test_service !== 'string') {
    e.push('compose.files, compose.services and compose.test_service are required');
  } else {
    for (const s of [...k.services, k.test_service]) if (!SERVICE.test(s)) e.push(`compose service name "${s}" is invalid`);
    if (k.services.includes(k.test_service)) e.push('compose.test_service must not also be listed in compose.services');
    if (k.timeout_seconds !== undefined && !(Number.isInteger(k.timeout_seconds) && k.timeout_seconds > 0)) e.push('compose.timeout_seconds must be a positive integer');
  }
  if (c.limits?.attempts !== undefined && !(Number.isInteger(c.limits.attempts) && c.limits.attempts > 0)) e.push('limits.attempts must be a positive integer');
  return e;
}

export function loadConfig(repo) {
  const config = readJson(configPath(repo));
  const errors = validateConfig(config);
  if (errors.length > 0) fail(`harness.json is invalid:\n  - ${errors.join('\n  - ')}`);
  return config;
}

export function validateTask(t) {
  const e = [];
  if (!t || typeof t !== 'object' || Array.isArray(t)) return ['task must be an object'];
  unknownKeys(t, ['schema_version', 'id', 'title', 'specification', 'acceptance_criteria', 'allowed_paths', 'base_ref'], 'task', e);
  if (t.schema_version !== 1) e.push('schema_version must be 1');
  if (typeof t.id !== 'string' || !TASK_ID.test(t.id)) e.push('id must match ^[a-z0-9][a-z0-9-]{0,47}$');
  for (const f of ['title', 'specification']) if (typeof t[f] !== 'string' || !t[f].trim()) e.push(`${f} is required`);
  if (!isStrings(t.acceptance_criteria, 1)) e.push('acceptance_criteria needs at least one observable criterion');
  if (!isStrings(t.allowed_paths, 1)) e.push('allowed_paths needs at least one path');
  else for (const p of t.allowed_paths) if (!SAFE_PATH.test(p)) e.push(`allowed path "${p}" must be repo-relative without "..", backslashes or .git`);
  if (typeof t.base_ref !== 'string' || !t.base_ref || t.base_ref.startsWith('-')) e.push('base_ref is required');
  else if (/[<>]/.test(t.base_ref)) e.push('base_ref is still a placeholder; pin an approved commit');
  return e;
}

/** Checks that need the repository: the base resolves and the scope is editable. */
export function validateTaskInRepo(task, config, repo) {
  const e = validateTask(task);
  if (e.length > 0) return { errors: e, base: null };
  const r = git(repo.root, 'rev-parse', '--verify', '--quiet', `${task.base_ref}^{commit}`);
  const base = r.code === 0 ? r.stdout.trim() : null;
  if (!base) e.push(`base_ref "${task.base_ref}" does not resolve to a commit`);
  const guarded = protectedPaths(config);
  for (const p of task.allowed_paths) {
    if (coveredBy(guarded, p) || guarded.some((g) => `${g}/`.startsWith(`${p}/`))) e.push(`allowed path "${p}" overlaps a protected path`);
    else if (!coveredBy(config.policy.editable_paths, p)) e.push(`allowed path "${p}" is outside policy.editable_paths`);
  }
  return { errors: e, base };
}
