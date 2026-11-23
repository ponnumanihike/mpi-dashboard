/* Local server: serves the dashboard, runs the same S3 API that Vercel runs (api/csv-url.js),
 * and stores shared data in data/*.json.
 *
 *   npm install   (once)
 *   npm run dev   -> http://localhost:3000   (PORT env var to change; reads .env)
 *
 * API:  /api/csv-url           -> api/csv-url.js (S3 read / upload / delete; see that file)
 *       GET /api/store/<key>   -> saved JSON (or null)
 *       PUT /api/store/<key>   -> save JSON body
 * Keys: history (upload history), dq (data quality report)
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch (e) { /* no .env: S3 API answers 503 */ }
const { default: csvUrl } = await import('./api/csv-url.js');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const KEYS = new Set(['history', 'dq']);
const MAX_BODY = 50 * 1024 * 1024;
const TYPES = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8',
  '.csv':'text/csv; charset=utf-8', '.json':'application/json', '.png':'image/png', '.svg':'image/svg+xml', '.ico':'image/x-icon' };

fs.mkdirSync(DATA_DIR, { recursive: true });
const fileFor = k => path.join(DATA_DIR, k + '.json');

function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}

/* Run a Vercel-style handler (req.query, req.body, res.status().json()) on a plain Node request. */
function runVercelHandler(handler, req, res, url) {
  const chunks = []; let size = 0;
  req.on('data', c => { size += c.length; if (size > MAX_BODY) req.destroy(); else chunks.push(c); });
  req.on('end', async () => {
    const started = Date.now();
    const text = Buffer.concat(chunks).toString('utf8');
    req.query = Object.fromEntries(url.searchParams);
    req.body = text;
    if (text && /application\/json/i.test(req.headers['content-type'] || '')) { try { req.body = JSON.parse(text); } catch (e) {} }
    res.status = code => { res.statusCode = code; return res; };
    res.json = obj => { if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(obj)); return res; };
    try { await handler(req, res); }
    catch (e) { console.error(e); if (!res.headersSent) res.status(500).json({ error: 'Internal error' }); }
    console.log(`${req.method} ${url.pathname}${url.search} -> ${res.statusCode} (${Date.now() - started} ms)`);
  });
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/csv-url') return runVercelHandler(csvUrl, req, res, url);
  const m = url.pathname.match(/^\/api\/store\/(\w+)$/);

  if (m) {
    const key = m[1];
    if (!KEYS.has(key)) return send(res, 404, '{"error":"unknown key"}');
    if (req.method === 'GET') {
      fs.readFile(fileFor(key), 'utf8', (err, txt) => send(res, 200, err ? 'null' : txt));
      return;
    }
    if (req.method === 'PUT') {
      let size = 0; const chunks = [];
      req.on('data', c => { size += c.length; if (size > MAX_BODY) { req.destroy(); } else chunks.push(c); });
      req.on('end', () => {
        const txt = Buffer.concat(chunks).toString('utf8');
        try { JSON.parse(txt); } catch (e) { return send(res, 400, '{"error":"invalid json"}'); }
        const tmp = fileFor(key) + '.tmp';           // write atomically so a crash can't corrupt saved data
        fs.writeFile(tmp, txt, err => {
          if (err) return send(res, 500, '{"error":"write failed"}');
          fs.rename(tmp, fileFor(key), e2 => send(res, e2 ? 500 : 200, e2 ? '{"error":"write failed"}' : '{"ok":true}'));
        });
      });
      return;
    }
    return send(res, 405, '{"error":"method not allowed"}');
  }

  // static files
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(ROOT, rel));
  const relPath = path.relative(ROOT, file);
  const blocked = /^(data|node_modules|api)([\\/]|$)/.test(relPath) || /(^|[\\/])\./.test(relPath) || /server\.js$/.test(file);   // dotfiles (.env, .git) never served
  if (!file.startsWith(ROOT) || blocked) return send(res, 403, 'Forbidden', 'text/plain');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    send(res, 200, buf, TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream');
  });
}).listen(PORT, '0.0.0.0', () => {
  console.log(`MPI dashboard running at http://localhost:${PORT}  (data saved in ${DATA_DIR})`);
  console.log(process.env.S3_ACCESS_KEY_ID
    ? `S3: s3://${process.env.S3_BUCKET || 'hike-mpi'}/uploads/{mdm,dq}/  (${process.env.S3_REGION || 'ap-south-1'})`
    : 'S3 disabled: set S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY in .env');
  if (!process.env.UPLOAD_KEY) console.log('Uploads disabled: set UPLOAD_KEY in .env');
});
