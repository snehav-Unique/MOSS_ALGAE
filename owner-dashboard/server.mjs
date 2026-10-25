import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {createServer} from 'node:http';
import {extname, join, normalize} from 'node:path';
import {fileURLToPath} from 'node:url';

const host = process.env.OWNER_DASHBOARD_HOST || (process.env.RENDER ? '0.0.0.0' : '127.0.0.1');
const port = Number(process.env.PORT || process.env.OWNER_DASHBOARD_PORT || 3001);
// A dedicated API instance on 8001 keeps this console independent from the
// public dashboard and its API process on 3000/8000.
const apiOrigin = (process.env.OWNER_API_URL || 'http://127.0.0.1:8001').replace(/\/$/, '');
const publicDirectory = fileURLToPath(new URL('./public/', import.meta.url));
const contentTypes = {'.css':'text/css; charset=utf-8','.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml'};

function sendJson(response, status, payload) {
  response.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
  response.end(JSON.stringify(payload));
}

async function proxySuggestions(request, response) {
  try {
    const upstream = await fetch(`${apiOrigin}/api/suggestions`, {
      headers: {Accept:'application/json',Authorization:request.headers.authorization || '','X-Owner-Key':request.headers['x-owner-key'] || ''},
      signal: AbortSignal.timeout(15000),
    });
    const body = await upstream.text();
    response.writeHead(upstream.status, {'Content-Type':upstream.headers.get('content-type') || 'application/json; charset=utf-8','Cache-Control':'no-store'});
    response.end(body);
  } catch {
    sendJson(response, 502, {detail:`Cannot reach the owner API at ${apiOrigin}. Start the Firestore backend on port 8001.`});
  }
}

async function serveFile(pathname, response) {
  const requested = pathname === '/' ? 'index.html' : pathname.slice(1);
  const relativePath = normalize(requested).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(publicDirectory, relativePath);
  if (!filePath.startsWith(publicDirectory)) return sendJson(response, 403, {detail:'Forbidden'});
  try {
    const details = await stat(filePath);
    if (!details.isFile()) throw new Error('Not a file');
    response.writeHead(200, {
      'Content-Type':contentTypes[extname(filePath)] || 'application/octet-stream',
      'Cache-Control':extname(filePath) === '.html' ? 'no-store' : 'public, max-age=300',
      'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer',
    });
    createReadStream(filePath).pipe(response);
  } catch { sendJson(response, 404, {detail:'Not found'}); }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || `${host}:${port}`}`);
  if (request.method === 'GET' && url.pathname === '/api/suggestions') return proxySuggestions(request, response);
  if (request.method !== 'GET') return sendJson(response, 405, {detail:'Method not allowed'});
  return serveFile(url.pathname, response);
});

server.listen(port, host, () => {
  console.log(`MOSS–ALGAE owner feedback: http://${host}:${port}`);
  console.log(`Firestore API proxy: ${apiOrigin}`);
});
