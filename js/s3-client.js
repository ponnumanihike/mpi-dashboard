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

let s3Locked = false;   // the server wants DASHBOARD_KEY and we don't have a valid one

/* Shown when neither S3 nor reports/ has data, so the page isn't silently empty */
function s3ShowNoData(){
  if(typeof showStatus !== 'function') return;
  if(s3Locked) showStatus('info', 'Locked — enter the dashboard access key above.');
  else if(s3LastError) showStatus('error', 'Could not load data from S3: ' + s3LastError);
  else showStatus('info', 'No data yet. No report has been uploaded to S3.');
}

function getDashKey(){ try { return sessionStorage.getItem('mpiKey') || ''; } catch(e){ return ''; } }

/* Inline access-key bar (same as the JHP dashboard), shown above the status message instead of a pop-up */
function s3ShowGate(wrongKey){
  let gate = document.getElementById('accessGate');
  if(!gate){
    gate = document.createElement('form');
    gate.id = 'accessGate';
    gate.className = 'access-gate';
    gate.innerHTML =
      '<span>&#128274; This dashboard is protected. Access key:</span>' +
      '<input type="password" id="accessKey" autocomplete="current-password" required/>' +
      '<button type="submit">Unlock</button>' +
      '<span class="access-gate-err" id="accessGateErr"></span>';
    gate.addEventListener('submit', e => {
      e.preventDefault();
      const k = document.getElementById('accessKey').value.trim();
      if(!k) return;
      try { sessionStorage.setItem('mpiKey', k); } catch(err){}
      location.reload();   // reload so the page loads its data with the key
    });
    const bar = document.querySelector('.data-status-bar');
    if(bar) bar.insertBefore(gate, bar.firstChild); else document.body.prepend(gate);
  }
  document.getElementById('accessGateErr').textContent = wrongKey ? 'That key was not accepted.' : '';
  document.getElementById('accessKey').focus();
}

/* Newest CSV in uploads/<type>/ -> { text, name, modified } or null (nothing there / API unavailable) */
async function s3Latest(type){
  if(!S3_API_AVAILABLE || s3Locked) return null;
  let res;
  const key = getDashKey();
  try {
    res = await fetch(S3_API + '?type=' + type + '&latest=1', { cache: 'no-store', headers: { 'x-dashboard-key': key } });
  } catch(e){ return null; }
  if(res.status === 401){
    s3Locked = true;
    if(key){ try { sessionStorage.removeItem('mpiKey'); } catch(e){} }   // saved key is wrong; ask again
    s3ShowGate(!!key);
    return null;
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
