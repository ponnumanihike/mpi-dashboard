// Vercel serverless function: serves the MPI dashboard's CSV data from a private S3 bucket.
//
// The bucket stays private (Block Public Access on). AWS credentials exist only in Vercel env vars.
// Files are read server-side and returned as data, so the browser never receives an S3 URL that
// could be copied and downloaded. Requests must come from this site's own pages (Sec-Fetch-Site),
// so pasting the API URL into the address bar or calling it from another website is refused.
//
//   GET  /api/csv-url?type=mdm|dq[&latest=1]
//        -> { files: [{ name, modified, size, text }] }   oldest → newest
//        Needs header `x-dashboard-key` when DASHBOARD_KEY is set.
//
//   GET  /api/csv-url?type=mdm|dq&manage=1
//        -> { files: [{ name, key, modified, size }] }   file list for the upload page, no contents
//
//   POST /api/csv-url   JSON { type: 'mdm'|'dq', filename: 'x.csv', size: <bytes> }
//        -> { key, url, fields }   signed POST form, valid 2 min, text/csv only, ≤ 4 MB, key chosen by the server
//
//   DELETE /api/csv-url?key=uploads/mdm/<file>.csv
//        -> { deleted: key }
//
//   manage=1, POST and DELETE always need header `x-upload-key` matching UPLOAD_KEY.
//
// Env vars (Vercel → Project → Settings → Environment Variables):
//   S3_BUCKET             default hike-mpi
//   S3_REGION             default ap-south-1
//   S3_ACCESS_KEY_ID      IAM user limited to uploads/* in this bucket (AWS_* names are reserved by Vercel)
//   S3_SECRET_ACCESS_KEY
//   UPLOAD_KEY            required to upload; uploads are disabled when unset
//   DASHBOARD_KEY         optional; when set, viewing the dashboard needs this key too

import crypto from 'node:crypto';
import { S3Client, ListObjectsV2Command, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';

const BUCKET = process.env.S3_BUCKET || 'hike-mpi';
const REGION = process.env.S3_REGION || 'ap-south-1';
const PREFIXES = { mdm: 'uploads/mdm/', dq: 'uploads/dq/' };
const MAX_BYTES = 4 * 1024 * 1024;
// Vercel caps a function response at 4.5 MB, so all files returned in one GET must fit under this.
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const POST_TTL_SECONDS = 120;

let client;
function s3() {
  if (!process.env.S3_ACCESS_KEY_ID || !process.env.S3_SECRET_ACCESS_KEY) {
    throw new ConfigError('S3 credentials are not configured on the server');
  }
  client ??= new S3Client({
    region: REGION,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    },
  });
  return client;
}

class ConfigError extends Error {}

// Constant-time comparison; hashing first makes both buffers the same length.
function keyMatches(given, expected) {
  if (typeof given !== 'string' || !given || !expected) return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

// Browsers send Sec-Fetch-Site on every request. Only fetch() calls from this site's own pages are allowed:
// typing/pasting the URL is a 'navigate' request, and other websites show up as 'cross-site'.
function fromOwnPage(req) {
  return req.headers['sec-fetch-site'] === 'same-origin' && req.headers['sec-fetch-mode'] !== 'navigate';
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Vary', 'Sec-Fetch-Site, Sec-Fetch-Mode');
  if (!fromOwnPage(req)) return res.status(403).json({ error: 'Forbidden' });
  try {
    if (req.method === 'GET') return req.query.manage === '1' ? await manageList(req, res) : await listFiles(req, res);
    if (req.method === 'POST') return await createUpload(req, res);
    if (req.method === 'DELETE') return await deleteFile(req, res);
    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    if (err instanceof ConfigError) return res.status(503).json({ error: err.message });
    console.error('csv-url failed:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

async function listFiles(req, res) {
  const dashboardKey = process.env.DASHBOARD_KEY;
  if (dashboardKey && !keyMatches(req.headers['x-dashboard-key'], dashboardKey)) {
    return res.status(401).json({ error: 'Access key required' });
  }
  const prefix = PREFIXES[req.query.type];
  if (!prefix) return res.status(400).json({ error: 'type must be mdm or dq' });

  const objects = await listCsvObjects(prefix);
  const wanted = req.query.latest === '1' ? objects.slice(-1) : objects;

  const total = wanted.reduce((sum, o) => sum + o.Size, 0);
  if (total > MAX_RESPONSE_BYTES) {
    return res.status(413).json({ error: `The ${req.query.type} files total ${(total / 1024 / 1024).toFixed(1)} MB, more than one response can carry` });
  }

  const files = await Promise.all(wanted.map(async (o) => {
    const obj = await s3().send(new GetObjectCommand({ Bucket: BUCKET, Key: o.Key }));
    return {
      name: o.Key.slice(prefix.length),
      modified: o.LastModified.toISOString(),
      size: o.Size,
      text: await obj.Body.transformToString('utf-8'),
    };
  }));
  return res.status(200).json({ bucket: BUCKET, files });
}

// CSV objects under a prefix, oldest → newest
async function listCsvObjects(prefix) {
  const objects = [];
  let token;
  do {
    const out = await s3().send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token }));
    for (const o of out.Contents || []) if (/\.csv$/i.test(o.Key)) objects.push(o);
    token = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (token);
  return objects.sort((a, b) => a.LastModified - b.LastModified || a.Key.localeCompare(b.Key));
}

// Upload, manage-list and delete all need the upload key. Returns true if the response was already sent.
function rejectWithoutUploadKey(req, res) {
  const uploadKey = process.env.UPLOAD_KEY;
  if (!uploadKey) { res.status(503).json({ error: 'Uploads are disabled (UPLOAD_KEY is not set)' }); return true; }
  if (!keyMatches(req.headers['x-upload-key'], uploadKey)) { res.status(401).json({ error: 'Invalid upload key' }); return true; }
  return false;
}

async function manageList(req, res) {
  if (rejectWithoutUploadKey(req, res)) return;
  const prefix = PREFIXES[req.query.type];
  if (!prefix) return res.status(400).json({ error: 'type must be mdm or dq' });
  const files = (await listCsvObjects(prefix)).map((o) => ({
    name: o.Key.slice(prefix.length),
    key: o.Key,
    modified: o.LastModified.toISOString(),
    size: o.Size,
  }));
  return res.status(200).json({ files });
}

async function deleteFile(req, res) {
  if (rejectWithoutUploadKey(req, res)) return;
  const key = req.query.key;
  // Only CSVs inside the two upload folders can be deleted
  const allowed = typeof key === 'string' && /\.csv$/i.test(key) && !key.split('/').includes('..') &&
    Object.values(PREFIXES).some((p) => key.startsWith(p) && key.length > p.length);
  if (!allowed) return res.status(400).json({ error: 'Not a deletable file' });

  try {
    await s3().send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404) return res.status(404).json({ error: 'File not found (it may already be deleted)' });
    throw err;
  }
  await s3().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  console.log('csv-url deleted', key);
  return res.status(200).json({ deleted: key });
}

async function createUpload(req, res) {
  if (rejectWithoutUploadKey(req, res)) return;

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  const { type, filename, size } = body || {};
  const prefix = PREFIXES[type];
  if (!prefix) return res.status(400).json({ error: 'type must be mdm or dq' });
  if (typeof filename !== 'string' || !/\.csv$/i.test(filename)) return res.status(400).json({ error: 'Only .csv files are allowed' });
  if (!Number.isInteger(size) || size < 1 || size > MAX_BYTES) {
    return res.status(400).json({ error: `File must be between 1 byte and ${MAX_BYTES / 1024 / 1024} MB` });
  }

  // Timestamp + random suffix: new uploads never overwrite existing files, and S3 order follows upload order.
  const safeName = filename.replace(/\.csv$/i, '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '').slice(0, 80) || 'report';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const key = `${prefix}${stamp}_${crypto.randomBytes(3).toString('hex')}_${safeName}.csv`;

  const { url, fields } = await createPresignedPost(s3(), {
    Bucket: BUCKET,
    Key: key,
    Conditions: [
      ['content-length-range', 1, MAX_BYTES],
      ['eq', '$Content-Type', 'text/csv'],
    ],
    Fields: { 'Content-Type': 'text/csv' },
    Expires: POST_TTL_SECONDS,
  });
  return res.status(200).json({ key, url, fields });
}
