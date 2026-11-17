/* ===== MPI Dashboard — Data Quality report (e.g. ProScan_DQ_Report_YYYYMMDD.csv) =====
 * Columns: snapshot_date, client, area, check, issue_type, records, denominator, pct, severity, notes
 * The file is (1) displayed as a findings table and (2) validated field by field.
 */

const DQR_COLS = ['snapshot_date','client','area','check','issue_type','records','denominator','pct','severity','notes'];
const DQR_REQUIRED = DQR_COLS.filter(c => c !== 'notes');          // notes may be blank
const DQR_SEVERITIES = ['High','Medium','Low','Info'];
const DQR_TYPES = ['Missing','Invalid','Placeholder','Review','Valid value','Format','Duplicate'];
const DQR_PCT_TOLERANCE = 0.011;                                     // pct is published to 2 decimals
const DQR_STORE = 'dq_report_data';
const DQR_STORE_NAME = 'dq_report_name';

let dqrRows = [], dqrIssues = [], dqrFile = '';

function dqrEsc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function dqrNum(v){ return /^-?\d+(\.\d+)?$/.test(String(v).trim()) ? Number(v) : NaN; }
function dqrFmt(n){ return Number(n).toLocaleString('en-US'); }
function dqrCanon(list, v){ return list.find(x => x.toLowerCase() === String(v).trim().toLowerCase()); }

function isDQReportHeaders(h){ return h.includes('check') && h.includes('issue_type') && h.includes('denominator'); }

/* ---------- load ---------- */
function processDQReport(lines, fname){
  const headers = lines[0].split(',').map(normalizeHeader);
  const missing = DQR_COLS.filter(c => !headers.includes(c));
  if(missing.length){ showStatus('error', 'Data quality report is missing columns: ' + missing.join(', ')); return; }
  const dups = headers.filter((h,i) => headers.indexOf(h) !== i);
  if(dups.length){ showStatus('error', 'Duplicate columns in data quality report: ' + [...new Set(dups)].join(', ')); return; }

  const rows = [];
  for(let i = 1; i < lines.length; i++){
    const vals = parseCSVLine(lines[i]);
    if(!vals.length || (vals.length === 1 && vals[0] === '')) continue;
    const r = { _line: i + 1 };
    headers.forEach((h, idx) => r[h] = (vals[idx] || '').trim());
    rows.push(r);
  }
  if(!rows.length){ showStatus('error', 'Data quality report has no data rows.'); return; }

  try {
    sessionStorage.setItem(DQR_STORE, JSON.stringify(rows));
    sessionStorage.setItem(DQR_STORE_NAME, fname);
  } catch(e){ /* storage full — still display */ }
  dqrRows = rows; dqrFile = fname;
  showStatus('success', `✓ Loaded data quality report "${fname}" — ${rows.length} checks`);
  runDQReport();
}

document.addEventListener('DOMContentLoaded', () => {
  try {
    const s = sessionStorage.getItem(DQR_STORE);
    if(!s) return;
    dqrRows = JSON.parse(s); dqrFile = sessionStorage.getItem(DQR_STORE_NAME) || 'data quality report';
    if(dqrRows.length) runDQReport();
  } catch(e){ /* ignore */ }
});

/* ---------- validation ---------- */
function validateDQReport(rows){
  const issues = [];
  const add = (key, r, sev, msg) => issues.push({ key, row: r._line, area: r.area || '—', check: r.check || '—', severity: sev, issue: msg });
  const today = new Date().toISOString().slice(0, 10);
  const dates = new Set(rows.map(r => r.snapshot_date).filter(Boolean));
  const clients = new Set(rows.map(r => r.client).filter(Boolean));
  const seen = {};

  rows.forEach(r => {
    DQR_REQUIRED.forEach(c => { if(isBlank(r[c])) add('blank', r, 'Error', `Missing value in "${c}"`); });

    if(r.snapshot_date){
      const ok = /^\d{4}-\d{2}-\d{2}$/.test(r.snapshot_date) && !isNaN(Date.parse(r.snapshot_date));
      if(!ok) add('date', r, 'Error', `snapshot_date must be YYYY-MM-DD (got "${r.snapshot_date}")`);
      else if(r.snapshot_date > today) add('date', r, 'Warning', `snapshot_date ${r.snapshot_date} is in the future`);
    }

    const rec = dqrNum(r.records), den = dqrNum(r.denominator), pct = dqrNum(r.pct);
    if(!isBlank(r.records) && (isNaN(rec) || rec < 0 || !Number.isInteger(rec))) add('count', r, 'Error', `records must be a non-negative whole number (got "${r.records}")`);
    if(!isBlank(r.denominator) && (isNaN(den) || den < 0 || !Number.isInteger(den))) add('count', r, 'Error', `denominator must be a non-negative whole number (got "${r.denominator}")`);
    if(!isBlank(r.pct) && isNaN(pct)) add('pct', r, 'Error', `pct must be numeric (got "${r.pct}")`);
    else if(!isNaN(pct) && (pct < 0 || pct > 100)) add('pct', r, 'Error', `pct out of range: ${pct} (must be 0–100)`);

    if(!isNaN(rec) && !isNaN(den)){
      if(den === 0) add('den', r, 'Error', 'denominator is 0');
      else if(rec > den) add('exceed', r, 'Error', `records (${dqrFmt(rec)}) exceed denominator (${dqrFmt(den)})`);
      if(den > 0 && !isNaN(pct)){
        const calc = rec / den * 100;
        if(Math.abs(calc - pct) > DQR_PCT_TOLERANCE) add('calc', r, 'Error', `pct ${pct} does not match records ÷ denominator (${calc.toFixed(2)})`);
      }
    }

    if(!isBlank(r.severity) && !dqrCanon(DQR_SEVERITIES, r.severity)) add('sev', r, 'Warning', `Unrecognised severity "${r.severity}" (expected High, Medium, Low or Info)`);
    if(!isBlank(r.issue_type) && !dqrCanon(DQR_TYPES, r.issue_type)) add('type', r, 'Warning', `Unrecognised issue_type "${r.issue_type}"`);

    const key = (r.area + '||' + r.check).toLowerCase();
    if(seen[key]) add('dup', r, 'Warning', `Duplicate check "${r.check}" in area "${r.area}" (also on row ${seen[key]})`);
    else seen[key] = r._line;
  });

  if(dates.size > 1) issues.push({ key:'consistency', row:'—', area:'—', check:'—', severity:'Warning', issue:`File mixes ${dates.size} snapshot dates: ${[...dates].join(', ')}` });
  if(clients.size > 1) issues.push({ key:'consistency', row:'—', area:'—', check:'—', severity:'Warning', issue:`File mixes ${clients.size} clients: ${[...clients].join(', ')}` });
  return issues;
}

/* ---------- render ---------- */
function runDQReport(){
  dqrIssues = validateDQReport(dqrRows);
  const sev = s => dqrRows.filter(r => (dqrCanon(DQR_SEVERITIES, r.severity) || '') === s).length;
  const set = (id, v) => { const el = document.getElementById(id); if(el) el.textContent = v; };

  const first = dqrRows[0] || {};
  set('dqr-title', `${first.client || 'Client'} data quality report`);
  set('dqr-sub', `${dqrFile} · snapshot ${first.snapshot_date || '—'} · ${dqrRows.length} checks across ${new Set(dqrRows.map(r => r.area)).size} areas`);
  set('dqr-total', dqrFmt(dqrRows.length));
  set('dqr-high', sev('High'));
  set('dqr-med', sev('Medium'));
  set('dqr-low', sev('Low') + sev('Info'));
  set('dqr-low-d', `${sev('Low')} low · ${sev('Info')} info`);
  const errs = dqrIssues.filter(i => i.severity === 'Error').length;
  set('dqr-valid', dqrIssues.length);
  const vd = document.getElementById('dqr-valid-d');
  if(vd){ vd.textContent = dqrIssues.length ? `${errs} errors · ${dqrIssues.length - errs} warnings` : 'All fields valid'; vd.className = 'delta ' + (dqrIssues.length ? 'dn' : 'up'); }

  // filters
  const areaSel = document.getElementById('dqrArea');
  if(areaSel){
    const prev = areaSel.value;
    const areas = [...new Set(dqrRows.map(r => r.area))];
    areaSel.innerHTML = '<option value="all">All areas</option>' + areas.map(a => `<option value="${dqrEsc(a)}">${dqrEsc(a)}</option>`).join('');
    if(areas.includes(prev)) areaSel.value = prev;
  }

  renderDQRIssues();
  filterDQR();
  document.getElementById('dqrSection').classList.remove('hidden');
}

function renderDQRIssues(){
  const card = document.getElementById('dqrIssuesCard'); if(!card) return;
  card.classList.toggle('hidden', dqrIssues.length === 0);
  document.getElementById('dqrIssuesBody').innerHTML = dqrIssues.map(i => `<tr>
    <td>${i.row}</td><td>${dqrEsc(i.area)}</td><td>${dqrEsc(i.check)}</td>
    <td><span class="tbadge ${i.severity}">${i.severity}</span></td><td>${dqrEsc(i.issue)}</td></tr>`).join('');
}

const DQR_SEV_COLOR = { High:'#e85d2a', Medium:'#f59e0b', Low:'#3b82f6', Info:'#64748b' };
const DQR_SEV_RANK = { High:0, Medium:1, Low:2, Info:3 };

function filterDQR(){
  const q = (document.getElementById('dqrSearch')?.value || '').toLowerCase();
  const area = document.getElementById('dqrArea')?.value || 'all';
  const sev = document.getElementById('dqrSeverity')?.value || 'all';
  const type = document.getElementById('dqrType')?.value || 'all';
  const sort = document.getElementById('dqrSort')?.value || 'file';
  const badRows = new Set(dqrIssues.map(i => i.row));

  let list = dqrRows.filter(r =>
    (area === 'all' || r.area === area) &&
    (sev === 'all' || dqrCanon(DQR_SEVERITIES, r.severity) === sev) &&
    (type === 'all' || dqrCanon(DQR_TYPES, r.issue_type) === type) &&
    (!q || (r.check + ' ' + r.notes + ' ' + r.area).toLowerCase().includes(q)));

  if(sort === 'pct') list = [...list].sort((a, b) => (dqrNum(b.pct) || 0) - (dqrNum(a.pct) || 0));
  else if(sort === 'records') list = [...list].sort((a, b) => (dqrNum(b.records) || 0) - (dqrNum(a.records) || 0));
  else if(sort === 'severity') list = [...list].sort((a, b) => (DQR_SEV_RANK[dqrCanon(DQR_SEVERITIES, a.severity)] ?? 9) - (DQR_SEV_RANK[dqrCanon(DQR_SEVERITIES, b.severity)] ?? 9));

  document.getElementById('dqrCount').textContent = `${list.length} of ${dqrRows.length} checks`;
  document.getElementById('dqrBody').innerHTML = list.map(r => {
    const sv = dqrCanon(DQR_SEVERITIES, r.severity) || r.severity;
    const pct = dqrNum(r.pct);
    const w = isNaN(pct) ? 0 : Math.max(0, Math.min(100, pct));
    const col = DQR_SEV_COLOR[sv] || '#64748b';
    return `<tr>
      <td>${dqrEsc(r.area)}</td>
      <td>${dqrEsc(r.check)}${badRows.has(r._line) ? ' <span class="tbadge Warning" title="This row failed report validation">⚠</span>' : ''}</td>
      <td>${dqrEsc(r.issue_type)}</td>
      <td class="num">${isNaN(dqrNum(r.records)) ? dqrEsc(r.records) : dqrFmt(r.records)}</td>
      <td class="num">${isNaN(dqrNum(r.denominator)) ? dqrEsc(r.denominator) : dqrFmt(r.denominator)}</td>
      <td class="dqr-pct"><div class="comp-track"><div class="comp-fill" style="width:${Math.max(w, w > 0 ? 1 : 0)}%;background:${col}"></div></div><span>${dqrEsc(r.pct)}%</span></td>
      <td><span class="tbadge sev-${dqrEsc(sv)}">${dqrEsc(sv)}</span></td>
      <td class="dqr-notes">${dqrEsc(r.notes)}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="8" style="text-align:center;padding:14px;">No checks match the filters</td></tr>';
}
