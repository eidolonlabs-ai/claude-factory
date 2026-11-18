import path from 'node:path';

export const ENV_ALLOWED = new Set(['.env.example', '.env.sample', '.env.template', '.env.test']);
export const KEY_NAMES = new Set(['id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa']);
export const KEY_EXTS = new Set(['.pem', '.key']);

/** Harness controls no task may edit. Compose files are added from the config. */
export const FIXED_PROTECTED = ['harness.json', '.harness', '.claude/settings.json', '.claude/settings.local.json', '.github', '.dockerignore'];
export const CONTROL_FILES = ['harness.json'];
export const CONTROL_PREFIXES = ['.harness/'];
export const HOLDOUT_MARKERS = ['holdout/', '.holdout.'];

/**
 * Repo-relative POSIX path for `target`, or null when it resolves outside
 * `root`. `a/../.env` becomes `.env`. Nothing is read from disk.
 */
export function relativeTo(root, target, cwd = root) {
  const abs = path.resolve(path.isAbsolute(target) ? '/' : cwd, target);
  const rel = path.relative(path.resolve(root), abs);
  if (rel === '') return '.';
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i += glob[i + 2] === '/' ? 2 : 1;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}(?:/.*)?$`);
}

/** A pattern covers itself, everything beneath it, and simple globs. */
export function covers(pattern, rel) {
  const p = pattern.replace(/^\.\//, '').replace(/\/+$/, '');
  if (p === '' || p === '.') return true;
  if (/[*?]/.test(p)) return globToRegExp(p).test(rel);
  return rel === p || rel.startsWith(`${p}/`);
}

export function coveredBy(patterns, rel) {
  return (patterns ?? []).some((p) => covers(p, rel));
}

// Identity rules compare case-insensitively: on macOS and Windows `.ENV` is `.env`.
export function isSecretPath(rel) {
  const base = path.posix.basename(rel).toLowerCase();
  if (base.startsWith('.env') && !ENV_ALLOWED.has(base)) return 'environment file';
  if (KEY_NAMES.has(base) || KEY_EXTS.has(path.posix.extname(base))) return 'private key';
  return null;
}

export function isHoldout(rel, markers = HOLDOUT_MARKERS) {
  return markers.some((m) => (m.endsWith('/') ? `/${rel}/`.includes(`/${m}`) : path.posix.basename(rel).includes(m)));
}

export function protectedPaths(config) {
  return [...FIXED_PROTECTED, ...(config?.policy?.protected_paths ?? []), ...(config?.compose?.files ?? [])];
}

/**
 * Decide whether a write to `rel` is acceptable. `ctx` carries the control
 * directory, frozen files and, while a task is active, its scope.
 * `asDir` asks about removing or replacing a directory.
 */
export function classifyWrite(rel, ctx = {}, asDir = false) {
  const dir = `${rel}/`;
  const low = rel.toLowerCase();
  if (low === '.git' || low.startsWith('.git/')) return 'Git internals are off limits';
  const secret = isSecretPath(rel);
  if (secret) return `${rel} is ${secret === "environment file" ? "an" : "a"} ${secret}`;
  for (const p of ctx.controlPrefixes ?? CONTROL_PREFIXES) {
    if (`${low}/`.startsWith(p.toLowerCase())) return `${rel} is in the harness control directory`;
  }
  if ((ctx.controlFiles ?? CONTROL_FILES).some((f) => f.toLowerCase() === low)) return `${rel} is harness configuration; the owner edits it`;
  if (isHoldout(rel, ctx.holdoutMarkers) || isHoldout(dir, ctx.holdoutMarkers)) return `${rel} is a holdout`;
  const frozen = ctx.frozen ?? [];
  if (frozen.includes(rel)) return `${rel} is frozen`;
  if (asDir && frozen.some((f) => f.startsWith(dir))) return `${rel} contains frozen files`;
  if (!ctx.task) return null;
  if (coveredBy(ctx.protected, rel)) return `${rel} is a protected acceptance input for task ${ctx.task.id}`;
  if (asDir && (ctx.protected ?? []).some((p) => `${p}/`.startsWith(dir))) return `${rel} contains protected paths`;
  // Ignored paths (build output, dependencies) are not part of the candidate.
  if (ctx.isIgnored?.(rel)) return null;
  if (!coveredBy(ctx.task.allowed_paths, rel)) return `${rel} is outside the allowed paths of task ${ctx.task.id}`;
  if (ctx.editable && !coveredBy(ctx.editable, rel)) return `${rel} is outside policy.editable_paths`;
  return null;
}
