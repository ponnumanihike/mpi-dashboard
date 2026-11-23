/* Zero-dependency server: serves the dashboard AND stores uploaded data in data/store.json,
 * so everyone who opens the link sees the same saved data.
 *
 *   node server.js            -> http://localhost:3000   (PORT env var to change)
 *
 * API:  GET /api/store/<key>   -> saved JSON (or null)
 *       PUT /api/store/<key>   -> save JSON body
 * Keys: history (upload history), dq (data quality report)
 *
 * S3 (configured in .env, see .env.example):
 *       GET /api/s3/status               -> { enabled, bucket, mdm, dq }
 *       GET /api/s3/latest/<mdm|dq>      -> newest CSV in uploads/<folder>/ (file name in X-File-Name)
 *       PUT /api/s3/upload/<mdm|dq>?name=<file.csv>  -> store CSV body in uploads/<folder>/
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const s3 = require('./lib/s3');          // also loads .env

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

function readBody(req, cb) {
  let size = 0; const chunks = [];
  req.on('data', c => { size += c.length; if (size > MAX_BODY) { req.destroy(); } else chunks.push(c); });
  req.on('end', () => cb(Buffer.concat(chunks)));
}

function handleS3(req, res, url) {
  if (url.pathname === '/api/s3/status') {
    const c = s3.config();
    return send(res, 200, JSON.stringify({ enabled: s3.isConfigured(), bucket: c.bucket, mdm: s3.folderPrefix('mdm'), dq: s3.folderPrefix('dq') }));
  }
  const m = url.pathname.match(/^\/api\/s3\/(latest|upload)\/(mdm|dq)$/);
  if (!m) return send(res, 404, '{"error":"not found"}');
  if (!s3.isConfigured()) return send(res, 503, '{"error":"S3 not configured"}');
  const [, action, kind] = m;
  const fail = e => { console.error(e.message); send(res, 502, JSON.stringify({ error: e.message })); };

  if (action === 'latest' && req.method === 'GET') {
    s3.latestCsv(kind).then(f => {
      if (!f) return send(res, 404, '{"error":"no CSV in folder"}');
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store',
        'X-File-Name': encodeURIComponent(path.basename(f.key)), 'X-Last-Modified': f.lastModified });
      res.end(f.body);
    }, fail);
    return;
  }
  if (action === 'upload' && req.method === 'PUT') {
    readBody(req, body => {
      if (!body.length) return send(res, 400, '{"error":"empty file"}');
      s3.uploadCsv(kind, url.searchParams.get('name'), body)
        .then(key => send(res, 200, JSON.stringify({ ok: true, key, url: `s3://${s3.config().bucket}/${key}` })), fail);
    });
    return;
  }
  return send(res, 405, '{"error":"method not allowed"}');
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/s3/')) return handleS3(req, res, url);
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
  const blocked = /^(data|node_modules|lib|scripts)([\\/]|$)/.test(relPath) || /(^|[\\/])\./.test(relPath) || /server\.js$/.test(file);   // dotfiles (.env, .git) never served
  if (!file.startsWith(ROOT) || blocked) return send(res, 403, 'Forbidden', 'text/plain');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    send(res, 200, buf, TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream');
  });
}).listen(PORT, '0.0.0.0', () => {
  console.log(`MDM dashboard running at http://localhost:${PORT}  (data saved in ${DATA_DIR})`);
  const c = s3.config();
  console.log(s3.isConfigured()
    ? `S3 enabled: s3://${c.bucket}/${s3.folderPrefix('mdm')}  and  s3://${c.bucket}/${s3.folderPrefix('dq')}  (${c.region})`
    : 'S3 disabled: fill AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY in .env to enable');
});
