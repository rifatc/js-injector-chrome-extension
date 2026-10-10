// Tiny static server for E2E fixture pages. Pages under /csp* are served
// with a strict CSP header to prove injected user scripts are CSP-exempt.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pagesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'pages');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript' };

export async function startServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      const file = path.join(pagesDir, urlPath === '/' ? 'index.html' : urlPath);
      if (!file.startsWith(pagesDir)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      const body = await readFile(file);
      const headers = { 'content-type': types[path.extname(file)] || 'application/octet-stream' };
      if (urlPath.startsWith('/csp')) {
        headers['content-security-policy'] = "default-src 'self'; script-src 'self'";
      }
      res.writeHead(200, headers).end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}
