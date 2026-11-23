/* Push CSV reports to S3 from the command line (uses the same .env as server.js).
 *
 *   node scripts/s3-push.js                      -> uploads every *MDM*.csv to uploads/mdm/ and *DQ*.csv to uploads/dq/
 *                                                   from the project folder and reports/
 *   node scripts/s3-push.js mdm <file.csv> ...   -> uploads the given files to uploads/mdm/
 *   node scripts/s3-push.js dq  <file.csv> ...   -> uploads the given files to uploads/dq/
 *   node scripts/s3-push.js --list               -> lists what is in both folders
 */
const fs = require('fs');
const path = require('path');
const s3 = require('../lib/s3');

const ROOT = path.join(__dirname, '..');

function autoFiles() {
  const out = [];
  for (const dir of [ROOT, path.join(ROOT, 'reports')]) {
    for (const f of fs.readdirSync(dir)) {
      if (!/\.csv$/i.test(f) || /sample/i.test(f)) continue;
      if (/(^|[_\-\s])dq([_\-\s.]|$)|dq_latest/i.test(f)) out.push(['dq', path.join(dir, f)]);
      else if (/mdm/i.test(f)) out.push(['mdm', path.join(dir, f)]);
    }
  }
  return out;
}

(async () => {
  if (!s3.isConfigured()) {
    console.error('S3 is not configured: fill AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in .env');
    process.exit(1);
  }
  const bucket = s3.config().bucket;
  const args = process.argv.slice(2);

  if (args[0] === '--list') {
    for (const kind of ['mdm', 'dq']) {
      const files = await s3.listObjects(s3.folderPrefix(kind));
      console.log(`s3://${bucket}/${s3.folderPrefix(kind)}  (${files.length} objects)`);
      files.forEach(f => console.log(`  ${f.lastModified}  ${String(f.size).padStart(9)}  ${f.key}`));
    }
    return;
  }

  let jobs;
  if (args.length) {
    const kind = args[0];
    if (!['mdm', 'dq'].includes(kind) || args.length < 2) {
      console.error('Usage: node scripts/s3-push.js [mdm|dq] <file.csv> ...   or   --list');
      process.exit(1);
    }
    jobs = args.slice(1).map(f => [kind, path.resolve(f)]);
  } else {
    jobs = autoFiles();
    if (!jobs.length) { console.log('No MDM/DQ CSV files found.'); return; }
  }

  let failed = 0;
  for (const [kind, file] of jobs) {
    try {
      const key = await s3.uploadCsv(kind, path.basename(file), fs.readFileSync(file));
      console.log(`OK    ${path.relative(ROOT, file)}  ->  s3://${bucket}/${key}`);
    } catch (e) {
      failed++;
      console.error(`FAIL  ${path.relative(ROOT, file)}: ${e.message}`);
    }
  }
  if (failed) process.exit(1);
})().catch(e => { console.error(e.message); process.exit(1); });
