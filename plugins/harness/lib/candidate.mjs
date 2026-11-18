import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { git, gitOut, sha256 } from './util.mjs';

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
