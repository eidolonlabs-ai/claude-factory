import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { decide } from '../plugins/harness/lib/guard.mjs';

const suite = JSON.parse(fs.readFileSync(new URL('../contract/guard-cases.json', import.meta.url), 'utf8'));
const { root, control_dir: controlDir, frozen, holdout_markers: holdoutMarkers } = suite.context;
const ctx = { controlPrefixes: [controlDir], controlFiles: [], frozen, holdoutMarkers };

for (const c of suite.cases) {
  test(`contract guard case ${c.id}`, () => {
    const got = decide({ tool: c.tool, input: c.input, root, cwd: root, ctx });
    assert.equal(got.decision, c.expect, `${c.input} -> ${got.reason ?? 'no reason'}`);
  });
}

test('ask becomes deny when unattended', () => {
  const got = decide({ tool: 'shell', input: 'git reset --hard HEAD~1', root, ctx, unattended: true });
  assert.equal(got.decision, 'deny');
});
