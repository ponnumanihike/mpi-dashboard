/* Zero-dependency server: serves the dashboard AND stores uploaded data in data/store.json,
 * so everyone who opens the link sees the same saved data.
 *
 *   node server.js            -> http://localhost:3000   (PORT env var to change)
 *
 * API:  GET /api/store/<key>   -> saved JSON (or null)
 *       PUT /api/store/<key>   -> save JSON body
 * Keys: history (upload history), dq (data quality report)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
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

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
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
  const blocked = /^(data|node_modules|\.git|\.claude)([\\/]|$)/.test(path.relative(ROOT, file)) || /server\.js$/.test(file);
  if (!file.startsWith(ROOT) || blocked) return send(res, 403, 'Forbidden', 'text/plain');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    send(res, 200, buf, TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream');
  });
}).listen(PORT, '0.0.0.0', () => console.log(`MDM dashboard running at http://localhost:${PORT}  (data saved in ${DATA_DIR})`));
