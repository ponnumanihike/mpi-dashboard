/* Zero-dependency S3 client (AWS Signature V4) for the dashboard server.
 * Config comes from .env / environment:
 *   S3_PATH=s3://bucket/prefix/   AWS_REGION   AWS_ACCESS_KEY_ID   AWS_SECRET_ACCESS_KEY   [AWS_SESSION_TOKEN]
 *   S3_MDM_FOLDER (default mdm)   S3_DQ_FOLDER (default dq)
 */
const crypto = require('crypto');
const https = require('https');
const fs = require('fs');
const path = require('path');

/* Load .env without overriding variables already set in the environment. */
function loadEnv(file = path.join(__dirname, '..', '.env')) {
  let txt;
  try { txt = fs.readFileSync(file, 'utf8'); } catch (e) { return; }
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_]\w*)\s*=\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim().replace(/;$/, '').trim();              // allow S3_PATH='...';
    if (/^(['"]).*\1$/.test(val)) val = val.slice(1, -1);
    if (process.env[m[1]] === undefined || process.env[m[1]] === '') process.env[m[1]] = val;
  }
}
loadEnv();

function config() {
  const e = process.env;
  const m = (e.S3_PATH || '').match(/^s3:\/\/([^/]+)\/?(.*)$/);
  const prefix = m ? m[2].replace(/^\/+/, '').replace(/([^/])$/, '$1/') : '';
  return {
    bucket: m ? m[1] : '',
    prefix,
    region: e.AWS_REGION || e.AWS_DEFAULT_REGION || 'ap-south-1',
    accessKey: e.AWS_ACCESS_KEY_ID || '',
    secretKey: e.AWS_SECRET_ACCESS_KEY || '',
    sessionToken: e.AWS_SESSION_TOKEN || '',
    folders: { mdm: (e.S3_MDM_FOLDER || 'mdm').replace(/^\/+|\/+$/g, ''), dq: (e.S3_DQ_FOLDER || 'dq').replace(/^\/+|\/+$/g, '') },
  };
}
const isConfigured = () => { const c = config(); return !!(c.bucket && c.accessKey && c.secretKey); };
const folderPrefix = kind => { const c = config(); return c.prefix + c.folders[kind] + '/'; };

const sha256 = d => crypto.createHash('sha256').update(d).digest('hex');
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
const enc = s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

function request(method, key, query = {}, body = '', contentType) {
  const c = config();
  if (!c.bucket || !c.accessKey || !c.secretKey) return Promise.reject(new Error('S3 is not configured (set S3_PATH, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY in .env)'));
  const host = `${c.bucket}.s3.${c.region}.amazonaws.com`;
  const urlPath = '/' + key.split('/').map(enc).join('/');
  const qs = Object.keys(query).sort().map(k => enc(k) + '=' + enc(query[k])).join('&');
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body || '', 'utf8');
  const payloadHash = sha256(payload);

  const headers = { host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  if (c.sessionToken) headers['x-amz-security-token'] = c.sessionToken;
  if (contentType) headers['content-type'] = contentType;
  const signed = Object.keys(headers).sort();
  const canonical = [method, urlPath, qs, signed.map(h => `${h}:${String(headers[h]).trim()}\n`).join(''), signed.join(';'), payloadHash].join('\n');
  const scope = `${date}/${c.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const kSign = hmac(hmac(hmac(hmac('AWS4' + c.secretKey, date), c.region), 's3'), 'aws4_request');
  const sig = crypto.createHmac('sha256', kSign).update(toSign).digest('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${c.accessKey}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${sig}`;
  headers['content-length'] = payload.length;

  return new Promise((resolve, reject) => {
    const req = https.request({ host, method, path: urlPath + (qs ? '?' + qs : ''), headers }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode >= 300) {
          const code = (buf.toString().match(/<Code>([^<]+)<\/Code>/) || [])[1] || 'HTTP ' + res.statusCode;
          const msg = (buf.toString().match(/<Message>([^<]+)<\/Message>/) || [])[1] || '';
          const err = new Error(`S3 ${method} ${key || '/'} failed: ${code}${msg ? ' - ' + msg : ''}`);
          err.status = res.statusCode; err.code = code;
          return reject(err);
        }
        resolve({ status: res.statusCode, headers: res.headers, body: buf });
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('S3 request timed out')));
    req.end(payload);
  });
}

const xmlUnescape = s => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

async function listObjects(prefix) {
  const out = [];
  let token;
  do {
    const q = { 'list-type': '2', prefix };
    if (token) q['continuation-token'] = token;
    const xml = (await request('GET', '', q)).body.toString('utf8');
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const get = t => (m[1].match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`)) || [])[1] || '';
      out.push({ key: xmlUnescape(get('Key')), lastModified: get('LastModified'), size: Number(get('Size')) });
    }
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? xmlUnescape((xml.match(/<NextContinuationToken>([^<]+)</) || [])[1] || '') : null;
  } while (token);
  return out;
}

const getObject = async key => (await request('GET', key)).body;
const putObject = (key, body, type = 'text/csv; charset=utf-8') => request('PUT', key, {}, body, type);

/* Most recently modified CSV in uploads/<kind>/, or null. */
async function latestCsv(kind) {
  const files = (await listObjects(folderPrefix(kind))).filter(o => /\.csv$/i.test(o.key) && o.size > 0);
  if (!files.length) return null;
  files.sort((a, b) => (a.lastModified < b.lastModified ? 1 : -1));
  return { ...files[0], body: await getObject(files[0].key) };
}

/* Upload a CSV into uploads/<kind>/ under a safe file name. Returns the object key. */
async function uploadCsv(kind, fileName, body) {
  let name = path.basename(String(fileName || '')).replace(/[^\w.\- ]/g, '_').trim();
  if (!name) name = `${kind}_${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
  if (!/\.csv$/i.test(name)) name += '.csv';
  const key = folderPrefix(kind) + name;
  await putObject(key, body);
  return key;
}

module.exports = { config, isConfigured, folderPrefix, listObjects, getObject, putObject, latestCsv, uploadCsv };
