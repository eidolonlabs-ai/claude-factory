// A small shell reader for the guard. It does not execute anything and does
// not aim to be a full parser: it recognises the write and destructive forms
// the family contract names, including nested `sh -c`, `$(...)` and backticks.
// Programs that write files in ways it does not know are caught by the gate.

import path from 'node:path';

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const FETCHERS = new Set(['curl', 'wget']);
const RESERVED = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', '!', '{', '}']);
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
// Command prefixes and the flags of theirs that consume a value.
const PREFIXES = {
  sudo: ['-u', '-g', '-h', '-p', '-C', '-D', '-R', '-T', '-U'],
  doas: ['-u'],
  env: ['-u', '-C', '-S'],
  nice: ['-n'],
  ionice: ['-c', '-n'],
  timeout: ['-s', '-k'],
  exec: ['-a'],
  command: [], nohup: [], time: [], builtin: [], stdbuf: [],
};
const ROOTS = new Set(['/', '/*', '~', '~/', '~/*', '$HOME', '${HOME}', '$HOME/', '${HOME}/', '$HOME/*', '${HOME}/*']);
const SUBST = '$(…)';
const MAX_DEPTH = 8;

/** Split into words, operators and redirects; collect nested command text. */
export function tokenize(src) {
  const tokens = [];
  const nested = [];
  const heredocs = [];
  let word = null;
  let i = 0;
  const push = () => {
    if (word !== null) tokens.push({ t: 'word', v: word });
    word = null;
  };
  const add = (s) => {
    word = (word ?? '') + s;
  };
  const atCommandStart = () => word === null && (tokens.length === 0 || tokens[tokens.length - 1].t === 'op');
  // Text up to the matching close, honouring quotes so a quoted `)` does not end it.
  const readSubst = (open, close) => {
    let depth = 1;
    let j = i;
    while (j < src.length && depth > 0) {
      const ch = src[j];
      if (ch === '\\') j += 1;
      else if (ch === "'") {
        const end = src.indexOf("'", j + 1);
        j = end === -1 ? src.length : end;
      } else if (ch === '"') {
        j += 1;
        while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
      } else if (ch === open) depth += 1;
      else if (ch === close) depth -= 1;
      j += 1;
    }
    const inner = src.slice(i, j - 1);
    i = j;
    return inner;
  };
  const skipPast = (marker) => {
    const end = src.indexOf(marker, i);
    i = end === -1 ? src.length : end + marker.length;
  };
  const dollar = () => {
    if (src.startsWith('$((', i)) {
      i += 3;
      skipPast('))');
      add('0');
    } else if (src[i + 1] === '(') {
      i += 2;
      nested.push(readSubst('(', ')'));
      add(SUBST);
    } else {
      add('$');
      i += 1;
    }
  };
  const backtick = () => {
    const end = src.indexOf('`', i + 1);
    const stop = end === -1 ? src.length : end;
    nested.push(src.slice(i + 1, stop));
    add(SUBST);
    i = stop + 1;
  };
  const heredoc = () => {
    const strip = src[i] === '-';
    if (strip) i += 1;
    while (src[i] === ' ' || src[i] === '\t') i += 1;
    let delim = '';
    while (i < src.length && !/[\s;|&<>()]/.test(src[i])) {
      if (src[i] === "'" || src[i] === '"') {
        const end = src.indexOf(src[i], i + 1);
        const stop = end === -1 ? src.length : end;
        delim += src.slice(i + 1, stop);
        i = stop + 1;
      } else {
        if (src[i] === '\\') i += 1;
        delim += src[i] ?? '';
        i += 1;
      }
    }
    if (delim) heredocs.push({ delim, strip });
  };
  // A heredoc body is data for the command's stdin, never commands.
  const skipHeredocBodies = () => {
    while (heredocs.length > 0) {
      const { delim, strip } = heredocs.shift();
      while (i < src.length) {
        const end = src.indexOf('\n', i);
        const line = src.slice(i, end === -1 ? src.length : end);
        i = end === -1 ? src.length : end + 1;
        if ((strip ? line.replace(/^\t+/, '') : line) === delim) break;
      }
    }
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
    } else if (c === '\n') {
      push();
      tokens.push({ t: 'op', v: ';' });
      i += 1;
      skipHeredocBodies();
    } else if (c === ';') {
      push();
      tokens.push({ t: 'op', v: ';' });
      i += 1;
    } else if (c === '#' && word === null) {
      while (i < src.length && src[i] !== '\n') i += 1;
    } else if ((c === '<' || c === '>') && src[i + 1] === '(') {
      i += 2; // process substitution runs a command
      nested.push(readSubst('(', ')'));
      add(SUBST);
    } else if (c === '(' && src[i + 1] === '(' && atCommandStart()) {
      i += 2; // arithmetic command: comparisons, not redirects
      skipPast('))');
    } else if (c === '[' && src[i + 1] === '[' && /\s/.test(src[i + 2] ?? '') && atCommandStart()) {
      i += 2; // conditional expression: `>` compares strings
      skipPast(']]');
      tokens.push({ t: 'word', v: '[[' });
    } else if (c === '&' && src[i + 1] === '>') {
      push();
      i += src[i + 2] === '>' ? 3 : 2;
      tokens.push({ t: 'redir' });
    } else if (c === '|' && src[i + 1] === '&') {
      push();
      tokens.push({ t: 'op', v: '|' });
      i += 2;
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
      if (src[i] === '&' && /[\d-]/.test(src[i + 1] ?? '')) {
        i += 1; // duplicate a descriptor: `2>&1`, `>&2`
        while (i < src.length && /[\d-]/.test(src[i])) i += 1;
      } else {
        if (src[i] === '&') i += 1; // `>& file` writes the file
        tokens.push({ t: 'redir' });
      }
    } else if (c === '<') {
      if (word !== null && /^\d+$/.test(word)) word = null;
      push();
      if (src.startsWith('<<<', i)) {
        i += 3;
        tokens.push({ t: 'in' });
      } else if (src[i + 1] === '<') {
        i += 2;
        heredoc();
      } else {
        i += 1;
        tokens.push({ t: 'in' });
      }
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
const shortFlag = (flags, ch) => flags.some((f) => new RegExp(`^-[a-z]*${ch}[a-z]*$`).test(f));

function normalizeRoot(w) {
  let v = w.replace(/\/{2,}/g, '/');
  while (v.length > 1 && (v.endsWith('/.') || v.endsWith('/'))) v = v.replace(/\/\.?$/, '') || '/';
  return v;
}

const isRootOrHome = (w) => ROOTS.has(w) || ROOTS.has(normalizeRoot(w));

/** Positional arguments, dropping flags and the values of `valued` flags. */
function positionals(args, valued = []) {
  const out = [];
  for (let k = 0; k < args.length; k += 1) {
    if (args[k] === '--') {
      out.push(...args.slice(k + 1));
      break;
    }
    if (valued.includes(args[k])) k += 1;
    else if (!isFlag(args[k])) out.push(args[k]);
  }
  return out;
}

/** Drop reserved words, assignments and prefixes such as `sudo -u x` or `timeout 60`. */
function stripPrefixes(words) {
  let w = words;
  for (;;) {
    if (w.length === 0) return w;
    if (RESERVED.has(w[0]) || ASSIGN.test(w[0])) {
      w = w.slice(1);
      continue;
    }
    const name = base(w[0]);
    const valued = PREFIXES[name];
    if (valued === undefined) return w;
    w = w.slice(1);
    while (w.length > 0 && isFlag(w[0])) {
      const takesValue = valued.includes(w[0]);
      w = w.slice(takesValue ? 2 : 1);
    }
    if (name === 'env') while (w.length > 0 && ASSIGN.test(w[0])) w = w.slice(1);
    if (name === 'timeout') w = w.slice(1); // the duration
  }
}

/** Destination handling shared by cp, mv, ln, install and rsync. */
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
  let sources = rest;
  if (targetDir === null || targetDir === undefined) {
    if (rest.length === 0) return out;
    targetDir = rest[rest.length - 1];
    sources = rest.slice(0, -1);
    const certainDir = /(^|\/)\.{1,2}$|\/$/.test(targetDir);
    // `cp a b` may name a file or a directory: check `b` itself, and `b/a` by identity only.
    if (!certainDir) out.push({ path: targetDir });
    for (const s of sources) out.push({ path: `${targetDir.replace(/\/$/, '')}/${base(s.replace(/\/$/, ''))}`, soft: !certainDir });
  } else {
    for (const s of sources) out.push({ path: `${targetDir}/${base(s)}` });
    out.push({ path: targetDir, dir: true });
  }
  if (includeSources) sources.forEach((s) => out.push({ path: s, dir: true }));
  return out;
}

function gitCommand(args, found) {
  let k = 0;
  let dir = null;
  while (k < args.length && isFlag(args[k])) {
    if (args[k] === '-C') dir = args[k + 1];
    k += ['-C', '-c', '--git-dir', '--work-tree'].includes(args[k]) ? 2 : 1;
  }
  const sub = args[k];
  const rest = args.slice(k + 1);
  const flags = rest.filter(isFlag);
  const write = (p, extra = {}) => found.writes.push({ path: dir && !path.isAbsolute(p) ? path.join(dir, p) : p, dir: true, ...extra });
  if (sub === 'push') found.deny.push('git push is the owner\'s decision');
  if (['commit', 'merge', 'push', 'am', 'cherry-pick', 'revert', 'rebase'].includes(sub) && (flags.includes('--no-verify') || (sub === 'commit' && shortFlag(flags, 'n')))) {
    found.deny.push('--no-verify skips verification hooks');
  }
  if (sub === 'reset' && flags.includes('--hard')) found.ask.push('git reset --hard discards work');
  if (sub === 'clean' && (shortFlag(flags, 'f') || flags.includes('--force')) && !shortFlag(flags, 'n') && !flags.includes('--dry-run')) {
    found.ask.push('git clean removes untracked files');
  }
  if (sub === 'rebase' && (shortFlag(flags, 'i') || flags.includes('--interactive'))) found.ask.push('interactive rebase rewrites history');
  if (sub === 'checkout') {
    const split = rest.indexOf('--');
    const before = positionals(split === -1 ? rest : rest.slice(0, split), ['-b', '-B', '--orphan']);
    if (split !== -1) rest.slice(split + 1).forEach((p) => write(p, { revert: true, treeish: before.length > 0 }));
    else if (before.length > 1) before.slice(1).forEach((p) => write(p, { revert: true, treeish: true }));
    else if (before[0] === '.' || (before.length === 0 && (shortFlag(flags, 'f') || flags.includes('--force')))) write('.', { revert: true });
  }
  if (sub === 'restore') {
    const treeish = flags.some((f) => f === '-s' || f.startsWith('--source'));
    positionals(rest, ['-s', '--source']).forEach((p) => write(p, { revert: true, treeish }));
  }
  if (sub === 'rm' || sub === 'mv') positionals(rest).forEach((p) => write(p));
}

function sedOrPerl(name, args, found) {
  const inPlace = name === 'sed'
    ? args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'))
    : args.some((a) => /^-[a-zA-Z]*i/.test(a));
  if (!inPlace) return;
  const scripted = args.some((a) => /^-[a-zA-Z]*[ef]$/.test(a) || a.startsWith('--expression') || a.startsWith('--file'));
  const files = [];
  for (let k = 0; k < args.length; k += 1) {
    if (/^-[a-zA-Z]*[ef]$/.test(args[k])) k += 1;
    else if (args[k] === '' && /^-[a-zA-Z]*i$/.test(args[k - 1] ?? '')) continue; // BSD `sed -i ''`
    else if (!isFlag(args[k])) files.push(args[k]);
  }
  (scripted ? files : files.slice(1)).forEach((p) => found.writes.push({ path: p }));
}

function simpleCommand(words, found, depth, state) {
  const w = stripPrefixes(words);
  if (w.length === 0) return null;
  const name = base(w[0]);
  const args = w.slice(1);
  const plain = args.filter((a) => !isFlag(a));

  if (name === 'cd' || name === 'pushd') {
    const to = plain[0];
    // Later relative paths resolve against the new directory; an unknown one cannot be judged.
    if (to === undefined || to === '-' || /[$~*?]/.test(to)) state.cd = null;
    else if (state.cd !== null) state.cd = path.isAbsolute(to) ? to : path.join(state.cd, to);
  } else if (name === 'popd') state.cd = null;
  else if (SHELLS.has(name)) {
    const c = args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
    if (c !== -1 && args[c + 1] !== undefined) {
      if (args[c + 1].includes(SUBST)) state.shellRunsSubst = true;
      analyzeInto(args[c + 1], found, depth + 1, state.cd);
    } else if (args.some((a) => a.includes(SUBST))) state.shellRunsSubst = true;
  } else if (name === 'eval') analyzeInto(args.join(' '), found, depth + 1, state.cd);
  else if (name === 'xargs') simpleCommand(positionals(args, ['-n', '-I', '-L', '-P', '-d', '-s', '-E']), found, depth, state);
  else if (name === 'rm') {
    for (const p of positionals(args)) {
      if (isRootOrHome(p)) found.deny.push(`rm of ${p} is destructive`);
      found.writes.push({ path: p, dir: true });
    }
  } else if (/^mkfs(\.|$)/.test(name)) found.deny.push('mkfs formats a filesystem');
  else if (name === 'git') gitCommand(args, found);
  else if (name === 'docker') {
    const d = positionals(args, ['--context', '-c', '--config', '-H', '--host', '-l', '--log-level']).slice(0, 2);
    if (d[0] === 'prune' || (['system', 'volume', 'image', 'container', 'network', 'builder', 'buildx'].includes(d[0]) && d[1] === 'prune')) {
      found.deny.push('host-wide docker prune touches resources the factory did not create');
    }
  } else if (name === 'tee') plain.forEach((p) => found.writes.push({ path: p }));
  else if (name === 'cp' || name === 'install' || name === 'ln') found.writes.push(...destinations(args, false));
  else if (name === 'mv') found.writes.push(...destinations(args, true));
  else if (name === 'rsync') {
    const pos = positionals(args, ['-e', '--rsh', '--exclude', '--include', '--filter', '--files-from']);
    if (pos.length > 1) found.writes.push({ path: pos[pos.length - 1], dir: true });
  } else if (name === 'sed' || name === 'perl') sedOrPerl(name, args, found);
  else if (name === 'dd') {
    args.filter((a) => a.startsWith('of=')).forEach((a) => found.writes.push({ path: a.slice(3) }));
  } else if (name === 'find') {
    const expr = args.findIndex((a) => isFlag(a) || a === '(' || a === '!');
    const roots = expr === -1 ? args : args.slice(0, expr);
    const exec = args.findIndex((a) => a === '-exec' || a === '-execdir' || a === '-ok');
    const mutates = args.includes('-delete') || (exec !== -1 && ['rm', 'mv', 'truncate', 'shred', 'unlink'].includes(base(args[exec + 1] ?? '')));
    if (mutates) (roots.length > 0 ? roots : ['.']).forEach((p) => found.writes.push({ path: p, dir: true }));
  } else if (name === 'curl') {
    args.forEach((a, k) => {
      if (a === '-o' || a === '--output') found.writes.push({ path: args[k + 1] ?? '' });
    });
  } else if (name === 'wget') {
    args.forEach((a, k) => {
      if ((a === '-O' || a === '--output-document') && args[k + 1] !== '-') found.writes.push({ path: args[k + 1] ?? '' });
    });
  } else if (name === 'tar' || name === 'bsdtar') {
    const extracting = args.some((a) => a === '--extract' || /^-?[a-zA-Z]*x[a-zA-Z]*$/.test(a));
    const c = args.findIndex((a) => a === '-C' || a === '--directory');
    if (extracting && c !== -1 && args[c + 1]) found.writes.push({ path: args[c + 1], dir: true });
  } else if (name === 'truncate') positionals(args, ['-s', '--size', '-r', '--reference']).forEach((p) => found.writes.push({ path: p }));
  else if (name === 'touch') positionals(args, ['-t', '-d', '--date', '-r', '--reference']).forEach((p) => found.writes.push({ path: p }));
  else if (['rmdir', 'unlink', 'shred'].includes(name)) plain.forEach((p) => found.writes.push({ path: p, dir: true }));
  else if (name === 'chmod' || name === 'chown') plain.slice(1).forEach((p) => found.writes.push({ path: p }));
  else if (name === 'node' || name === 'nodejs') {
    const s = plain.findIndex((a) => /(^|\/)factory\.mjs$/.test(a));
    const sub = s === -1 ? null : plain[s + 1];
    if (['activate', 'deactivate', 'approve-plan', 'evidence'].includes(sub) && !args.includes('--approved')) {
      found.ask.push(`factory ${sub} is an owner checkpoint`);
    }
  }
  return name;
}

/** Analyze one command list. Returns the command names seen, for the caller's pipe checks. */
function analyzeInto(src, found, depth = 0, cd = '') {
  const seen = new Set();
  if (depth > MAX_DEPTH) {
    found.deny.push('command nesting is too deep to read');
    return seen;
  }
  if (/:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:/.test(src)) found.deny.push('fork bomb');
  const { tokens, nested } = tokenize(src);
  const state = { cd, shellRunsSubst: false };
  const nestedNames = new Set();
  for (const n of nested) analyzeInto(n, found, depth + 1, cd).forEach((x) => nestedNames.add(x));
  let words = [];
  let pipeline = [];
  let conditional = false;
  const endCommand = () => {
    if (words.length > 0 && !conditional) {
      const mark = found.writes.length;
      const name = simpleCommand(words, found, depth, state);
      for (let k = mark; k < found.writes.length; k += 1) if (found.writes[k].cd === undefined) found.writes[k].cd = state.cd;
      if (name) {
        pipeline.push(name);
        seen.add(name);
      }
    }
    words = [];
    conditional = false;
  };
  const endPipeline = () => {
    endCommand();
    const fetch = pipeline.findIndex((n) => FETCHERS.has(n));
    if (fetch !== -1 && pipeline.slice(fetch + 1).some((n) => SHELLS.has(n))) found.deny.push('piping a download into a shell runs unreviewed code');
    pipeline = [];
  };
  for (let k = 0; k < tokens.length; k += 1) {
    const tok = tokens[k];
    if (tok.t === 'word') {
      if (tok.v === '[[' && words.length === 0) conditional = true;
      words.push(tok.v);
    } else if (tok.t === 'redir' || tok.t === 'in') {
      const target = tokens[k + 1];
      if (target?.t === 'word') {
        if (tok.t === 'redir') found.writes.push({ path: target.v, cd: state.cd });
        k += 1;
      }
    } else if (tok.v === '|') endCommand();
    else endPipeline();
  }
  endPipeline();
  if (state.shellRunsSubst && [...nestedNames].some((n) => FETCHERS.has(n))) found.deny.push('running a download as shell code runs unreviewed code');
  nestedNames.forEach((x) => seen.add(x));
  return seen;
}

/**
 * @returns {{deny: string[], ask: string[], writes: {path: string, cd: string|null, dir?: boolean, soft?: boolean, revert?: boolean, treeish?: boolean}[]}}
 * `cd` is the directory, relative to the starting one, that the path resolves
 * against (null when it cannot be known). `dir` marks a target that may be a
 * directory; `soft` a guessed path inside a destination that may be a plain
 * file; `revert` a Git restore of committed content.
 */
export function analyze(command) {
  const found = { deny: [], ask: [], writes: [] };
  analyzeInto(String(command ?? ''), found);
  return found;
}
