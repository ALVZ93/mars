import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const siteRoot = resolve(fileURLToPath(new URL('.', import.meta.url)));
const port = Number(process.env.MARS_SITE_PORT || 4173);
const mime = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.json', 'application/json; charset=utf-8'],
]);

function resolvePath(pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const candidate = resolve(siteRoot, '.' + requested);
  const fromRoot = relative(siteRoot, candidate);
  return fromRoot.startsWith('..') || isAbsolute(fromRoot) ? null : candidate;
}

const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url || '/', 'http://' + (request.headers.host || 'localhost'));
  let pathname;
  try {
    pathname = decodeURIComponent(requestUrl.pathname);
  } catch {
    response.writeHead(400).end('Bad request');
    return;
  }
  const filePath = resolvePath(pathname);
  if (!filePath) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const body = await readFile(filePath);
    response.writeHead(200, {
      'Content-Type': mime.get(extname(filePath)) || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    }).end(body);
  } catch {
    response.writeHead(404).end('Not found');
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log('MARS site running at http://127.0.0.1:' + port);
});
