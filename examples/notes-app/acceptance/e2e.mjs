// End-to-end acceptance against the live service on the Compose network.
// This file is a protected acceptance input: a task may not edit it.
import assert from 'node:assert/strict';

const base = process.env.APP_URL ?? 'http://app:3000';
const post = (title) => fetch(`${base}/api/notes`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ title }),
});
const count = async () => (await (await fetch(`${base}/api/notes`)).json()).length;

const created = await post('  hello factory  ');
assert.equal(created.status, 201, 'a padded title is accepted');
assert.equal((await created.json()).title, 'hello factory', 'the stored title is trimmed');

const html = await (await fetch(`${base}/`)).text();
assert.ok(html.includes('<li data-testid="note-title">hello factory</li>'), 'the reloaded page shows the trimmed title');

const before = await count();
const rejected = await post('   \t ');
assert.equal(rejected.status, 400, 'a whitespace-only title is rejected');
assert.equal(await count(), before, 'no note is created for a rejected title');

console.log('acceptance: 5 assertions passed against', base);
