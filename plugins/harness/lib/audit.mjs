import fs from 'node:fs';
import path from 'node:path';
import { git } from './util.mjs';

const SQL = '(?:SELECT\\b.+\\bFROM\\b.+\\bWHERE\\b|INSERT\\s+INTO\\b.+\\bVALUES\\b|UPDATE\\b.+\\bSET\\b|DELETE\\s+FROM\\b.+\\bWHERE\\b)';
const RULES = [
  { id: 'private-key', severity: 'high', re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/, prose: true },
  { id: 'cloud-credential', severity: 'high', re: /\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36,}|sk-[A-Za-z0-9_-]{32,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/, prose: true },
  { id: 'dynamic-exec', severity: 'high', re: /(?:^|[^.\w])eval\s*\(|\bnew\s+Function\s*\(/ },
  { id: 'dynamic-exec', severity: 'high', re: /(?:^|[^.\w])exec\s*\(/, ext: ['.py'] },
  { id: 'shell-interpolation', severity: 'high', re: /(?:(?:^|[^.\w])exec(?:Sync)?|child_process\.exec(?:Sync)?)\s*\(\s*`[^`]*\$\{/ },
  { id: 'sql-interpolation', severity: 'high', re: new RegExp(`\`[^\`]*${SQL}[^\`]*\\$\\{`, 'i') },
  { id: 'sql-interpolation', severity: 'high', re: new RegExp(`\\bf["'][^"']*${SQL}[^"']*\\{`, 'i'), ext: ['.py'] },
  { id: 'sql-interpolation', severity: 'high', re: new RegExp(`["'][^"']*${SQL}[^"']*["']\\s*(?:\\+|%\\s|\\.format\\()`, 'i') },
  { id: 'hardcoded-secret', severity: 'medium', re: /\b(?:api[_-]?key|secret|passw(?:or)?d|token)\b["']?\s*[:=]\s*["'][^"'\s]{16,}["']/i },
];
const PROSE_EXT = new Set(['.md', '.mdx', '.txt', '.rst', '.adoc']);
const COMMENT = /^\s*(?:\/\/|#|\*|\/\*|<!--|--\s)/;

/** Added lines per file: `git diff` against the base plus whole untracked files. */
export function addedLines(root, base) {
  const out = [];
  // Fixed prefixes and no external driver, whatever the user's diff config says.
  const diff = git(root, 'diff', '-U0', '--no-renames', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', base ?? 'HEAD', '--');
  let file = null;
  let line = 0;
  let header = false;
  for (const l of diff.stdout.split('\n')) {
    if (l.startsWith('diff --git ')) {
      header = true;
      file = null;
    } else if (header && l.startsWith('+++ ')) file = l.startsWith('+++ b/') ? l.slice(6).replace(/\t$/, '') : null;
    else if (l.startsWith('@@')) {
      header = false; // only lines before the first hunk are headers; `++ i;` in code is content
      line = Number(/\+(\d+)/.exec(l)?.[1] ?? 1);
    } else if (!header && file && l.startsWith('+')) out.push({ file, line: line++, text: l.slice(1) });
  }
  const untracked = git(root, 'ls-files', '-o', '--exclude-standard', '-z').stdout.split('\0').filter(Boolean);
  for (const rel of untracked) {
    try {
      const abs = path.join(root, rel);
      const st = fs.lstatSync(abs);
      if (!st.isFile() || st.size > 1024 * 1024) continue;
      const text = fs.readFileSync(abs, 'utf8');
      if (text.includes('\0')) continue;
      text.split('\n').forEach((t, i) => out.push({ file: rel, line: i + 1, text: t }));
    } catch {
      // unreadable files are not audited
    }
  }
  return out;
}

/**
 * Pattern scan of what the candidate adds. A convenience net, not a security
 * review: code patterns skip prose files and comment lines, secrets do not.
 */
export function auditDiff(root, base) {
  const findings = [];
  for (const { file, line, text: full } of addedLines(root, base)) {
    const text = full.slice(0, 5000);
    const ext = path.extname(file);
    const prose = PROSE_EXT.has(ext) || COMMENT.test(text);
    for (const rule of RULES) {
      if (rule.ext && !rule.ext.includes(ext)) continue;
      if (prose && !rule.prose && rule.severity === 'high') continue;
      if (rule.re.test(text)) {
        findings.push({ rule: rule.id, severity: rule.severity, where: `${file}:${line}` });
        break;
      }
    }
  }
  return findings;
}
