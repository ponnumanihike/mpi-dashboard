/* ===== MPI Dashboard — S3 data (same API as the JHP dashboard: /api/csv-url) =====
 * The bucket stays private: api/csv-url.js (Vercel function, or `npm run dev` locally) reads the CSV
 * server-side and returns its text. type 'mdm' -> s3://<bucket>/uploads/mdm/, 'dq' -> uploads/dq/.
 * If the server sets DASHBOARD_KEY, the viewer is asked for it once per browser session.
 * Uploading / deleting files is done on upload.html (needs UPLOAD_KEY). */

const S3_API = '/api/csv-url';
// Live Server (VS Code) and file:// have no API; skip the call so the pages use reports/*.csv quietly
const S3_API_AVAILABLE = location.protocol.startsWith('http') && !['5500', '5501'].includes(location.port);

/* Hidden shortcut (same as the JHP dashboard): 3 clicks/taps on the MPI DASHBOARD title within 1.5 s
   opens the upload page. There is no visible link; the page itself still needs the upload key. */
(function(){
  let clicks = 0, timer = null;
  const uploadUrl = (location.pathname.includes('/pages/') ? '../' : '') + 'upload.html';
  document.addEventListener('DOMContentLoaded', () => {
    const title = document.querySelector('.topbar-title');
    if(!title) return;
    title.style.userSelect = 'none';            // no text selection on the triple click
    title.addEventListener('click', () => {
      clicks++; clearTimeout(timer);
      if(clicks >= 3){ clicks = 0; location.href = uploadUrl; return; }
      timer = setTimeout(() => { clicks = 0; }, 1500);
    });
  });
})();

let s3LastError =S3_API_AVAILABLE ? '' :
  'this page is open through Live Server / a file, which cannot reach S3. Run "npm run dev" and open http://localhost:3000';

/* Shown when neither S3 nor reports/ has data, so the page isn't silently empty */
function s3ShowNoData(){
  if(typeof showStatus !== 'function') return;
  if(s3LastError) showStatus('error', 'Could not load data from S3: ' + s3LastError);
  else showStatus('info', 'No data yet. No report has been uploaded to S3.');
}

function getDashKey(){ try { return sessionStorage.getItem('mpiKey') || ''; } catch(e){ return ''; } }

/* Newest CSV in uploads/<type>/ -> { text, name, modified } or null (nothing there / API unavailable) */
async function s3Latest(type, retried){
  if(!S3_API_AVAILABLE) return null;
  let res;
  try {
    res = await fetch(S3_API + '?type=' + type + '&latest=1', { cache: 'no-store', headers: { 'x-dashboard-key': getDashKey() } });
  } catch(e){ return null; }
  if(res.status === 401 && !retried){
    const k = (prompt('Enter the dashboard access key') || '').trim();
    if(!k) return null;
    try { sessionStorage.setItem('mpiKey', k); } catch(e){}
    return s3Latest(type, true);
  }
  if(!res.ok){
    let j = {};
    try { j = await res.json(); } catch(e){}
    s3LastError = (j.error || 'HTTP ' + res.status) + (res.status === 500 ? ' (see the server log; often missing S3 permissions)' : '');
    console.warn('S3 ' + type + ' load failed: ' + s3LastError);
    return null;
  }
  let j = {};
  try { j = await res.json(); } catch(e){ return null; }
  const f = (j.files || [])[j.files ? j.files.length - 1 : 0];
  if(!f || !String(f.text || '').trim()) return null;
  s3LastError = '';
  // Stored names look like 2026-10-02T10-29-54-213Z_c6910c_Report.csv; show the original part
  return { text: f.text, name: f.name.replace(/^\d{4}-\d{2}-\d{2}T[\d-]+Z_[0-9a-f]{6}_/, ''), modified: f.modified, bucket: j.bucket };
}
