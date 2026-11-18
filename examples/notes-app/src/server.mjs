import http from 'node:http';
import { normalizeTitle } from './title.mjs';

const notes = [];
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page() {
  const items = notes.map((n) => `<li data-testid="note-title">${escapeHtml(n.title)}</li>`).join('');
  return `<!doctype html><meta charset="utf-8"><title>Notes</title><h1>Notes</h1><ul data-testid="notes">${items}</ul>`;
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'content-type': type });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') return send(res, 200, page(), 'text/html; charset=utf-8');
  if (req.method === 'GET' && req.url === '/api/notes') return send(res, 200, notes);
  if (req.method === 'POST' && req.url === '/api/notes') {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 64 * 1024) req.destroy();
    });
    req.on('end', () => {
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return send(res, 400, { error: 'invalid JSON' });
      }
      const title = normalizeTitle(body?.title);
      if (title === null) return send(res, 400, { error: 'title is required' });
      const note = { id: notes.length + 1, title };
      notes.push(note);
      return send(res, 201, note);
    });
    return undefined;
  }
  return send(res, 404, { error: 'not found' });
});

server.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
