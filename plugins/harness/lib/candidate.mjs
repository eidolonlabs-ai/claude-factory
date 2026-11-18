import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { git, gitOut, sh, sha256 } from './util.mjs';
import { coveredBy } from './policy.mjs';

// Agent worktrees live under .claude/worktrees and are separate candidates.
const zlist = (s) => s.split('\0').filter((p) => p && !p.startsWith('.claude/worktrees/'));

/** Tracked plus untracked, non-ignored files: the Git candidate. */
export function candidateFiles(root) {
  return [...new Set(zlist(gitOut(root, 'ls-files', '-co', '--exclude-standard', '-z')))].sort();
}

/**
 * Digest of the candidate's content, covering unstaged and untracked files.
 * Ignored files, images and external services are outside it by design.
 */
export function candidateHash(root) {
  const h = createHash('sha256');
  for (const rel of candidateFiles(root)) {
    const abs = path.join(root, rel);
    let content;
    try {
      const st = fs.lstatSync(abs);
      if (st.isSymbolicLink()) content = `link:${fs.readlinkSync(abs)}`;
      else if (st.isDirectory()) content = `gitlink:${git(abs, 'rev-parse', 'HEAD').stdout.trim()}`;
      else content = fs.readFileSync(abs);
    } catch {
      continue; // deleted in the working tree
    }
    h.update(`${rel}\0${sha256(content)}\n`);
  }
  return h.digest('hex');
}

/** Every path that differs from `base`: committed, staged, unstaged and untracked. */
export function changedPaths(root, base) {
  const diff = zlist(gitOut(root, 'diff', '--name-only', '--no-renames', '-z', base, '--'));
  const untracked = zlist(gitOut(root, 'ls-files', '-o', '--exclude-standard', '-z'));
  return [...new Set([...diff, ...untracked])].sort();
}

/** Symlinks in changed paths could point a write at a protected file. */
export function symlinkedPaths(root, paths) {
  return paths.filter((rel) => {
    let dir = root;
    for (const part of rel.split('/')) {
      dir = path.join(dir, part);
      try {
        if (fs.lstatSync(dir).isSymbolicLink()) return true;
      } catch {
        return false;
      }
    }
    return false;
  });
}

/**
 * Ways the working tree can differ from what `git diff` reports. The scope
 * check must not depend on index flags or ignore rules an agent can change:
 * protected files are compared by content against the base tree.
 */
export function integrityProblems(root, base, protectedPatterns) {
  const problems = [];
  for (const entry of gitOut(root, 'ls-files', '-v', '-z').split('\0').filter(Boolean)) {
    const tag = entry[0];
    if (tag === 'S' || tag === tag.toLowerCase()) problems.push(`${entry.slice(2)}: index flag hides changes (skip-worktree or assume-unchanged)`);
  }
  for (const p of zlist(gitOut(root, 'ls-files', '-o', '--exclude-standard', '-z'))) {
    if (p.endsWith('/')) problems.push(`${p}: nested repository; its contents are invisible to the gate`);
  }

  const tree = new Map();
  for (const entry of gitOut(root, 'ls-tree', '-r', '-z', base).split('\0').filter(Boolean)) {
    const [meta, file] = entry.split('\t');
    const [mode, , sha] = meta.split(' ');
    tree.set(file, { mode, sha });
  }
  const hashes = (files) => {
    if (files.length === 0) return [];
    const r = sh('git', ['hash-object', '--stdin-paths'], { cwd: root, input: `${files.join('\n')}\n` });
    return r.stdout.trim().split('\n');
  };
  const isFile = (rel) => {
    try {
      return fs.lstatSync(path.join(root, rel)).isFile();
    } catch {
      return false;
    }
  };

  // Ignore rules decide what counts as the candidate, so they may not change under a task.
  const everything = zlist(gitOut(root, 'ls-files', '-co', '-z'));
  const ignoreFiles = [...new Set(everything.filter((p) => path.posix.basename(p) === '.gitignore'))].filter(isFile);
  hashes(ignoreFiles).forEach((sha, i) => {
    if (tree.get(ignoreFiles[i])?.sha !== sha) problems.push(`${ignoreFiles[i]}: ignore rules differ from the base`);
  });

  const guarded = [...tree.keys()].filter((p) => coveredBy(protectedPatterns, p) && tree.get(p).mode !== '160000');
  const present = [];
  for (const rel of guarded) {
    const { mode, sha } = tree.get(rel);
    let st = null;
    try {
      st = fs.lstatSync(path.join(root, rel));
    } catch {
      // missing
    }
    if (!st) problems.push(`${rel}: protected file is missing`);
    else if (mode === '120000') {
      const target = st.isSymbolicLink() ? fs.readlinkSync(path.join(root, rel)) : null;
      if (target === null || git(root, 'cat-file', '-p', sha).stdout !== target) problems.push(`${rel}: protected symlink changed`);
    } else if (!st.isFile()) problems.push(`${rel}: protected file was replaced`);
    else present.push(rel);
  }
  hashes(present).forEach((sha, i) => {
    if (tree.get(present[i]).sha !== sha) problems.push(`${present[i]}: protected file differs from the base`);
  });
  return problems;
}
