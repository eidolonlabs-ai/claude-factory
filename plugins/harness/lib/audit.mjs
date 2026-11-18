import fs from 'node:fs';
import path from 'node:path';
import { git } from './util.mjs';

const RULES = [
  { id: 'private-key', severity: 'high', re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
  { id: 'cloud-credential', severity: 'high', re: /\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36,}|sk-[A-Za-z0-9_-]{32,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/ },
  { id: 'dynamic-exec', severity: 'high', re: /(?:^|[^.\w])eval\s*\(|\bnew\s+Function\s*\(/ },
  { id: 'dynamic-exec', severity: 'high', re: /(?:^|[^.\w])exec\s*\(/, ext: ['.py'] },
  { id: 'shell-interpolation', severity: 'high', re: /\b(?:execSync|exec)\s*\(\s*`[^`]*\$\{/ },
  { id: 'sql-interpolation', severity: 'high', re: /`[^`]*\b(?:SELECT\s.+\sFROM|INSERT\s+INTO|UPDATE\s.+\sSET|DELETE\s+FROM)\b[^`]*\$\{/i },
  { id: 'sql-interpolation', severity: 'high', re: /\bf["'][^"']*\b(?:SELECT\s.+\sFROM|INSERT\s+INTO|UPDATE\s.+\sSET|DELETE\s+FROM)\b[^"']*\{/i, ext: ['.py'] },
  { id: 'sql-interpolation', severity: 'high', re: /["'][^"']*\b(?:SELECT\s.+\sFROM|INSERT\s+INTO|UPDATE\s.+\sSET|DELETE\s+FROM)\b[^"']*["']\s*(?:\+|%|\.format\()/i },
  { id: 'hardcoded-secret', severity: 'medium', re: /\b(?:api[_-]?key|secret|passw(?:or)?d|token)\b["']?\s*[:=]\s*["'][^"'\s]{16,}["']/i },
];

/** Added lines per file: `git diff` against the base plus whole untracked files. */
export function addedLines(root, base) {
  const out = [];
  const diff = git(root, 'diff', '-U0', '--no-renames', '--no-color', base ?? 'HEAD', '--');
  let file = null;
  let line = 0;
  for (const l of diff.stdout.split('\n')) {
    if (l.startsWith('+++ ')) file = l.startsWith('+++ b/') ? l.slice(6) : null;
    else if (l.startsWith('@@')) line = Number(/\+(\d+)/.exec(l)?.[1] ?? 1);
    else if (file && l.startsWith('+')) out.push({ file, line: line++, text: l.slice(1) });
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

/** Pattern scan of what the candidate adds. A convenience net, not a security review. */
export function auditDiff(root, base) {
  const findings = [];
  for (const { file, line, text } of addedLines(root, base)) {
    if (text.length > 2000) continue;
    for (const rule of RULES) {
      if (rule.ext && !rule.ext.includes(path.extname(file))) continue;
      if (rule.re.test(text)) {
        findings.push({ rule: rule.id, severity: rule.severity, where: `${file}:${line}` });
        break;
      }
    }
  }
  return findings;
}
