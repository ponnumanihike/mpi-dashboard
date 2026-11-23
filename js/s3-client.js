/* ===== MPI Dashboard — S3 storage (via node server.js; credentials stay on the server) =====
 * kind: 'mdm' -> s3://<bucket>/uploads/mdm/   'dq' -> s3://<bucket>/uploads/dq/
 * Without the Node server (Vercel / Live Server) these calls 404 and the pages fall back to reports/*.csv. */

/* Newest CSV in the S3 folder -> { text, name } or null */
async function s3Latest(kind){
  try {
    const res = await fetch('/api/s3/latest/' + kind, { cache: 'no-store' });
    if(!res.ok) return null;
    const text = await res.text();
    if(!text.trim()) return null;
    return { text, name: decodeURIComponent(res.headers.get('X-File-Name') || kind + '.csv') };
  } catch(e){ return null; }
}

/* Save an uploaded CSV to the S3 folder and add a note to the upload status line. */
async function s3Upload(kind, text, fname){
  let res;
  try {
    res = await fetch('/api/s3/upload/' + kind + '?name=' + encodeURIComponent(fname || ''), {
      method: 'PUT', headers: { 'Content-Type': 'text/csv' }, body: text
    });
  } catch(e){ return null; }
  if(res.status === 404 || res.status === 503) return null;      // no Node server, or S3 not configured
  const st = document.getElementById('uploadStatus');
  let info = {};
  try { info = await res.json(); } catch(e){}
  if(st && !st.classList.contains('error')){
    st.textContent += res.ok ? ' · Saved to ' + info.url : ' · S3 upload failed: ' + (info.error || res.status);
  }
  return res.ok ? info : null;
}
