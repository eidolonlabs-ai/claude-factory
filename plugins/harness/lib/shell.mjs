// A small shell reader for the guard. It does not execute anything and does
// not aim to be a full parser: it recognises the write and destructive forms
// the family contract names, including nested `sh -c`, `$(...)` and backticks.

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const PREFIXES = new Set(['sudo', 'env', 'command', 'nohup', 'time', 'exec', 'builtin', 'nice']);
const ROOTS = new Set(['/', '/*', '~', '~/', '~/*', '$HOME', '${HOME}', '$HOME/', '${HOME}/', '$HOME/*', '${HOME}/*']);

/** Split into words, operators and redirects; collect nested command text. */
export function tokenize(src) {
  const tokens = [];
  const nested = [];
  let word = null;
  let i = 0;
  const push = () => {
    if (word !== null) tokens.push({ t: 'word', v: word });
    word = null;
  };
  const add = (s) => {
    word = (word ?? '') + s;
  };
  const readSubst = (open, close) => {
    let depth = 1;
    let j = i;
    while (j < src.length && depth > 0) {
      if (src[j] === '\\') j += 1;
      else if (src[j] === open) depth += 1;
      else if (src[j] === close) depth -= 1;
      j += 1;
    }
    const inner = src.slice(i, j - 1);
    i = j;
    return inner;
  };
  const dollar = () => {
    if (src[i + 1] === '(' && src[i + 2] !== '(') {
      i += 2;
      nested.push(readSubst('(', ')'));
      add('$(…)');
    } else {
      add('$');
      i += 1;
    }
  };
  const backtick = () => {
    const end = src.indexOf('`', i + 1);
    const stop = end === -1 ? src.length : end;
    nested.push(src.slice(i + 1, stop));
    add('$(…)');
    i = stop + 1;
  };
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      if (src[i + 1] !== '\n') add(src[i + 1] ?? '');
      i += 2;
    } else if (c === "'") {
      const end = src.indexOf("'", i + 1);
      const stop = end === -1 ? src.length : end;
      add(src.slice(i + 1, stop));
      i = stop + 1;
    } else if (c === '"') {
      add('');
      i += 1;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\' && '"\\$`'.includes(src[i + 1])) {
          add(src[i + 1]);
          i += 2;
        } else if (src[i] === '$') dollar();
        else if (src[i] === '`') backtick();
        else {
          add(src[i]);
          i += 1;
        }
      }
      i += 1;
    } else if (c === '$') dollar();
    else if (c === '`') backtick();
    else if (c === ' ' || c === '\t') {
      push();
      i += 1;
    } else if (c === '\n' || c === ';') {
      push();
      tokens.push({ t: 'op', v: ';' });
      i += 1;
    } else if (c === '#' && word === null) {
      while (i < src.length && src[i] !== '\n') i += 1;
    } else if (c === '&' && src[i + 1] === '>') {
      push();
      i += src[i + 2] === '>' ? 3 : 2;
      tokens.push({ t: 'redir' });
    } else if (c === '&' || c === '|') {
      push();
      const two = src[i + 1] === c;
      tokens.push({ t: 'op', v: two ? c + c : c });
      i += two ? 2 : 1;
    } else if (c === '(' || c === ')') {
      push();
      tokens.push({ t: 'op', v: ';' });
      i += 1;
    } else if (c === '>') {
      if (word !== null && /^\d+$/.test(word)) word = null;
      push();
      i += 1;
      if (src[i] === '>' || src[i] === '|') i += 1;
      if (src[i] === '&') {
        i += 1;
        while (i < src.length && /[\d-]/.test(src[i])) i += 1;
      } else tokens.push({ t: 'redir' });
    } else if (c === '<') {
      if (word !== null && /^\d+$/.test(word)) word = null;
      push();
      while (src[i] === '<') i += 1;
      tokens.push({ t: 'in' });
    } else {
      add(c);
      i += 1;
    }
  }
  push();
  return { tokens, nested };
}

const isFlag = (w) => w.startsWith('-') && w !== '-';
const base = (w) => w.split('/').pop();

function normalizeRoot(w) {
  let v = w.replace(/\/{2,}/g, '/');
  while (v.length > 1 && (v.endsWith('/.') || v.endsWith('/'))) v = v.replace(/\/\.?$/, '') || '/';
  return v;
}

function isRootOrHome(w) {
  return ROOTS.has(w) || ROOTS.has(normalizeRoot(w));
}

/** Destination handling shared by cp, mv, ln and install. */
function destinations(args, includeSources) {
  const out = [];
  const rest = [];
  let targetDir = null;
  for (let k = 0; k < args.length; k += 1) {
    const a = args[k];
    if (a === '-t' || a === '--target-directory') targetDir = args[++k];
    else if (a.startsWith('--target-directory=')) targetDir = a.slice(19);
    else if (!isFlag(a)) rest.push(a);
  }
  if (targetDir !== null && targetDir !== undefined) {
    for (const s of rest) out.push({ path: `${targetDir}/${base(s)}` });
    out.push({ path: targetDir, dir: true });
    if (includeSources) rest.forEach((s) => out.push({ path: s, dir: true }));
  } else if (rest.length > 0) {
    const dest = rest[rest.length - 1];
    out.push({ path: dest, dir: true });
    const sources = rest.slice(0, -1);
    if (sources.length > 0) out.push({ path: `${dest}/${base(sources[0])}`, soft: true });
    if (includeSources) sources.forEach((s) => out.push({ path: s, dir: true }));
  }
  return out;
}

function gitCommand(args, found) {
  let k = 0;
  while (k < args.length && isFlag(args[k])) k += ['-C', '-c', '--git-dir', '--work-tree'].includes(args[k]) ? 2 : 1;
  const sub = args[k];
  const rest = args.slice(k + 1);
  const flags = rest.filter(isFlag);
  const shortHas = (ch) => flags.some((f) => !f.startsWith('--') && f.includes(ch));
  if (sub === 'push') found.deny.push('git push is the owner\'s decision');
  if (sub === 'reset' && flags.includes('--hard')) found.ask.push('git reset --hard discards work');
  if (sub === 'clean' && (shortHas('f') || flags.includes('--force'))) found.ask.push('git clean removes untracked files');
  if (sub === 'rebase' && (shortHas('i') || flags.includes('--interactive'))) found.ask.push('interactive rebase rewrites history');
  if (sub === 'checkout' && rest.includes('--')) rest.slice(rest.indexOf('--') + 1).forEach((p) => found.writes.push({ path: p, dir: true }));
  if (sub === 'restore' || sub === 'rm' || sub === 'mv') rest.filter((a) => !isFlag(a)).forEach((p) => found.writes.push({ path: p, dir: true }));
}

function simpleCommand(words, found, depth) {
  let w = words.slice();
  while (w.length > 0 && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]) || PREFIXES.has(base(w[0])))) w.shift();
  if (w.length === 0) return null;
  const name = base(w[0]);
  const args = w.slice(1);
  const plain = args.filter((a) => !isFlag(a));
  if (args.includes('--no-verify')) found.deny.push('--no-verify skips verification hooks');

  if (SHELLS.has(name)) {
    const c = args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
    if (c !== -1 && args[c + 1] !== undefined) analyzeInto(args[c + 1], found, depth + 1);
  } else if (name === 'eval') analyzeInto(args.join(' '), found, depth + 1);
  else if (name === 'xargs') simpleCommand(plain, found, depth);
  else if (name === 'rm') {
    for (const p of plain) {
      if (isRootOrHome(p)) found.deny.push(`rm of ${p} is destructive`);
      found.writes.push({ path: p, dir: true });
    }
  } else if (/^mkfs(\.|$)/.test(name)) found.deny.push('mkfs formats a filesystem');
  else if (name === 'git') gitCommand(args, found);
  else if (name === 'docker') {
    const d = plain.slice(0, 2);
    if (d[0] === 'prune' || (['system', 'volume', 'image', 'container', 'network', 'builder'].includes(d[0]) && d[1] === 'prune')) {
      found.deny.push('host-wide docker prune touches resources the harness did not create');
    }
  } else if (name === 'tee') plain.forEach((p) => found.writes.push({ path: p }));
  else if (name === 'cp' || name === 'install' || name === 'ln') found.writes.push(...destinations(args, false));
  else if (name === 'mv') found.writes.push(...destinations(args, true));
  else if (name === 'sed' && args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'))) {
    const scripted = args.some((a) => a === '-e' || a === '-f' || a.startsWith('--expression') || a.startsWith('--file'));
    const files = [];
    for (let k = 0; k < args.length; k += 1) {
      if (args[k] === '-e' || args[k] === '-f') k += 1;
      else if (!isFlag(args[k])) files.push(args[k]);
    }
    (scripted ? files : files.slice(1)).forEach((p) => found.writes.push({ path: p }));
  } else if (name === 'dd') {
    args.filter((a) => a.startsWith('of=')).forEach((a) => found.writes.push({ path: a.slice(3) }));
  } else if (['truncate', 'touch', 'rmdir', 'unlink', 'shred'].includes(name)) {
    plain.forEach((p) => found.writes.push({ path: p, dir: true }));
  } else if (name === 'chmod' || name === 'chown') plain.slice(1).forEach((p) => found.writes.push({ path: p }));
  else if (name === 'node' || name === 'nodejs') {
    const s = plain.findIndex((a) => /(^|\/)harness\.mjs$/.test(a));
    const sub = s === -1 ? null : plain[s + 1];
    if (['activate', 'deactivate', 'approve-plan'].includes(sub) && !args.includes('--approved')) {
      found.ask.push(`harness ${sub} is an owner checkpoint`);
    }
  }
  return name;
}

function analyzeInto(src, found, depth = 0) {
  if (depth > 8) return;
  if (/:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:/.test(src)) found.deny.push('fork bomb');
  const { tokens, nested } = tokenize(src);
  nested.forEach((n) => analyzeInto(n, found, depth + 1));
  let words = [];
  let pipeline = [];
  const endCommand = () => {
    if (words.length > 0) pipeline.push(simpleCommand(words, found, depth));
    words = [];
  };
  const endPipeline = () => {
    endCommand();
    const fetch = pipeline.findIndex((n) => n === 'curl' || n === 'wget');
    if (fetch !== -1 && pipeline.slice(fetch + 1).some((n) => SHELLS.has(n))) found.deny.push('piping a download into a shell runs unreviewed code');
    pipeline = [];
  };
  for (let k = 0; k < tokens.length; k += 1) {
    const tok = tokens[k];
    if (tok.t === 'word') words.push(tok.v);
    else if (tok.t === 'redir' || tok.t === 'in') {
      const target = tokens[k + 1];
      if (target?.t === 'word') {
        if (tok.t === 'redir') found.writes.push({ path: target.v });
        k += 1;
      }
    } else if (tok.v === '|') endCommand();
    else endPipeline();
  }
  endPipeline();
}

/**
 * @returns {{deny: string[], ask: string[], writes: {path: string, dir?: boolean, soft?: boolean}[]}}
 * `dir` marks a target that may be a directory (its contents are affected);
 * `soft` marks a guessed path inside a destination that may be a plain file.
 */
export function analyze(command) {
  const found = { deny: [], ask: [], writes: [] };
  analyzeInto(String(command ?? ''), found);
  return found;
}
