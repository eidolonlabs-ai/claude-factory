import path from 'node:path';

export const ENV_ALLOWED = new Set(['.env.example', '.env.sample', '.env.template', '.env.test']);
export const KEY_NAMES = new Set(['id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa']);
export const KEY_EXTS = new Set(['.pem', '.key']);

/** Factory controls no task may edit. Compose files are added from the config. */
export const FIXED_PROTECTED = ['factory.json', '.factory', '.claude/settings.json', '.claude/settings.local.json', '.github', '.dockerignore'];
export const CONTROL_FILES = ['factory.json'];
export const CONTROL_PREFIXES = ['.factory/'];
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

function escapeChar(c) {
  return c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
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
    else if (c === '[') {
      const close = glob.indexOf(']', i + 1);
      const inner = close === -1 ? '' : glob.slice(i + 1, close);
      if (close > i + 1 && !inner.includes('/')) {
        const body = inner[0] === '!' ? `^${inner.slice(1)}` : inner;
        re += `[${body.replace(/\\/g, '\\\\')}]`;
        i = close;
      } else re += '\\[';
    } else re += escapeChar(c);
  }
  return new RegExp(`^${re}(?:/.*)?$`);
}

/** A pattern covers itself, everything beneath it, and simple globs. */
export function covers(pattern, rel) {
  const p = pattern.replace(/^\.\//, '').replace(/\/+$/, '');
  if (p === '' || p === '.') return true;
  if (/[*?[]/.test(p)) return globToRegExp(p).test(rel);
  return rel === p || rel.startsWith(`${p}/`);
}

export function coveredBy(patterns, rel) {
  return (patterns ?? []).some((p) => covers(p, rel));
}

export function coveredByCI(patterns, rel) {
  const low = rel.toLowerCase();
  return (patterns ?? []).some((p) => covers(p.toLowerCase(), low));
}

function parseSegTokens(seg) {
  const out = [];
  for (let i = 0; i < seg.length; i += 1) {
    const c = seg[i];
    if (c === '*') out.push({ kind: 'star' });
    else if (c === '?') out.push({ kind: 'any' });
    else if (c === '[') {
      const close = seg.indexOf(']', i + 1);
      if (close > i + 1) {
        const raw = seg.slice(i + 1, close);
        const neg = raw[0] === '!' || raw[0] === '^';
        const spec = neg ? raw.slice(1) : raw;
        const test = (ch) => {
          let hit = false;
          for (let k = 0; k < spec.length; k += 1) {
            if (k + 2 < spec.length && spec[k + 1] === '-') {
              if (ch >= spec[k] && ch <= spec[k + 2]) hit = true;
              k += 2;
            } else if (spec[k] === ch) hit = true;
          }
          return neg ? !hit : hit;
        };
        out.push({ kind: 'class', test });
        i = close;
      } else out.push({ kind: 'lit', ch: '[' });
    } else out.push({ kind: 'lit', ch: c });
  }
  return out;
}

function charsMatch(a, b) {
  const matchOne = (tok, ch) => {
    if (ch === '/') return false;
    if (tok.kind === 'any') return true;
    if (tok.kind === 'lit') return tok.ch === ch;
    return tok.test(ch);
  };
  if (a.kind === 'lit') return matchOne(b, a.ch);
  if (b.kind === 'lit') return matchOne(a, b.ch);
  for (let code = 32; code < 127; code += 1) {
    const ch = String.fromCharCode(code);
    if (matchOne(a, ch) && matchOne(b, ch)) return true;
  }
  return false;
}

function segsOverlap(s1, s2) {
  const t1 = parseSegTokens(s1);
  const t2 = parseSegTokens(s2);
  const memo = new Map();
  const dp = (i, j) => {
    const key = (i << 12) | j;
    if (memo.has(key)) return memo.get(key);
    let ok = false;
    if (i === t1.length && j === t2.length) ok = true;
    else if (i < t1.length && t1[i].kind === 'star') ok = dp(i + 1, j) || (j < t2.length && dp(i, j + 1));
    else if (j < t2.length && t2[j].kind === 'star') ok = dp(i, j + 1) || (i < t1.length && dp(i + 1, j));
    else if (i < t1.length && j < t2.length && charsMatch(t1[i], t2[j])) ok = dp(i + 1, j + 1);
    memo.set(key, ok);
    return ok;
  };
  return dp(0, 0);
}

/** True when two repo-relative path or glob patterns can match any common path. */
export function patternsOverlap(a, b) {
  if (covers(a, b) || covers(b, a)) return true;
  const pa = a.replace(/^\.\//, '').replace(/\/+$/, '');
  const pb = b.replace(/^\.\//, '').replace(/\/+$/, '');
  if (pa === '' || pa === '.' || pb === '' || pb === '.') return true;
  const sa = pa.split('/');
  const sb = pb.split('/');
  const memo = new Map();
  const dp = (i, j) => {
    const key = (i << 12) | j;
    if (memo.has(key)) return memo.get(key);
    let ok = false;
    if (i === sa.length || j === sb.length) ok = true;
    else if (sa[i] === '**') ok = dp(i + 1, j) || dp(i, j + 1);
    else if (sb[j] === '**') ok = dp(i, j + 1) || dp(i + 1, j);
    else if (segsOverlap(sa[i], sb[j])) ok = dp(i + 1, j + 1);
    memo.set(key, ok);
    return ok;
  };
  return dp(0, 0);
}

// Identity rules compare case-insensitively: on macOS and Windows `.ENV` is `.env`.
export function isSecretPath(rel) {
  const base = path.posix.basename(rel).toLowerCase();
  if (base.startsWith('.env') && !ENV_ALLOWED.has(base)) return 'environment file';
  if (KEY_NAMES.has(base) || KEY_EXTS.has(path.posix.extname(base))) return 'private key';
  return null;
}

export function isHoldout(rel, markers = HOLDOUT_MARKERS) {
  const low = rel.toLowerCase();
  return markers.some((m) => {
    const lm = m.toLowerCase();
    return lm.endsWith('/') ? `/${low}/`.includes(`/${lm}`) : path.posix.basename(low).includes(lm);
  });
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
  const lowDir = `${low}/`;
  if (low === '.git' || low.startsWith('.git/')) return 'Git internals are off limits';
  const secret = isSecretPath(rel);
  if (secret) return `${rel} is ${secret === "environment file" ? "an" : "a"} ${secret}`;
  for (const p of ctx.controlPrefixes ?? CONTROL_PREFIXES) {
    if (lowDir.startsWith(p.toLowerCase())) return `${rel} is in the factory control directory`;
  }
  // Configuration is written during setup and frozen at activation: it is only off limits while a task is active.
  if (ctx.task && (ctx.controlFiles ?? CONTROL_FILES).some((f) => f.toLowerCase() === low)) return `${rel} is factory configuration, frozen while task ${ctx.task.id} is active`;
  if (isHoldout(rel, ctx.holdoutMarkers) || isHoldout(dir, ctx.holdoutMarkers)) return `${rel} is a holdout`;
  const frozen = (ctx.frozen ?? []).map((f) => f.toLowerCase());
  if (frozen.includes(low)) return `${rel} is frozen`;
  if (asDir && frozen.some((f) => f.startsWith(lowDir))) return `${rel} contains frozen files`;
  if (!ctx.task) return null;
  if (coveredByCI(ctx.protected, rel)) return `${rel} is a protected acceptance input for task ${ctx.task.id}`;
  if (asDir && (ctx.protected ?? []).some((p) => `${p.toLowerCase()}/`.startsWith(lowDir))) return `${rel} contains protected paths`;
  // Ignored paths (build output, dependencies) are not part of the candidate.
  if (ctx.isIgnored?.(rel)) return null;
  if (!coveredBy(ctx.task.allowed_paths, rel)) return `${rel} is outside the allowed paths of task ${ctx.task.id}`;
  if (ctx.editable && !coveredBy(ctx.editable, rel)) return `${rel} is outside policy.editable_paths`;
  return null;
}
