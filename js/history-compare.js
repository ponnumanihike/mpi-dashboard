/* ===== MPI Dashboard — Upload history & report comparison =====
 * Every validated upload is saved to browser localStorage (this browser only).
 * Any two saved uploads can be compared and the comparison downloaded as its own
 * report (HTML for reading/printing, CSV for Excel).
 *
 * Each file is compared on its latest week; rows are matched on source_id.
 */

const HISTORY_KEY = 'mdm_upload_history';
const HISTORY_MAX = 25;
const CMP_JUMP_PCT = 5; // same threshold as status derivation in mdm-format.js
let lastComparison = null;

/* ---------- storage ---------- */
function loadHistory(){
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); }
  catch(e){ return []; }
}

function writeHistory(list){
  // Empty list: remove the key outright (otherwise deleting the last entry never persisted)
  if(!list.length){
    try { localStorage.removeItem(HISTORY_KEY); } catch(e){}
    return true;
  }
  // Drop the oldest entries until it fits in localStorage
  while(list.length){
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list)); return true; }
    catch(e){ if(list.length === 1) break; list.pop(); }
  }
  return false;
}

function saveToHistory(fname, rows, warnings){
  const list = loadHistory();
  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2,6),
    fname,
    uploadedAt: new Date().toISOString(),
    rowCount: rows.length,
    warnings: warnings || 0,
    weeks: [...new Set(rows.map(r => r.week))].sort(),
    rows
  };
  list.unshift(entry);
  if(list.length > HISTORY_MAX) list.length = HISTORY_MAX;
  if(!writeHistory(list)){
    setCmpMsg('error', 'Could not save this upload to history (browser storage is full). Delete older entries and try again.');
  }
  renderHistory(entry.id);
}

function deleteHistory(id){
  writeHistory(loadHistory().filter(e => e.id !== id));
  if(lastComparison && (lastComparison.base.id === id || lastComparison.cur.id === id)) clearComparison();
  renderHistory();
}

function clearHistory(){
  const btn = document.getElementById('clearHistoryBtn');
  // two-step confirm (no confirm() dialog)
  if(btn.dataset.armed !== '1'){
    btn.dataset.armed = '1'; btn.textContent = 'Click again to delete all';
    setTimeout(() => { btn.dataset.armed = ''; btn.textContent = 'Clear history'; }, 4000);
    return;
  }
  try { localStorage.removeItem(HISTORY_KEY); } catch(e){}
  btn.dataset.armed = ''; btn.textContent = 'Clear history';
  clearComparison();
  renderHistory();
}

function loadFromHistory(id){
  const e = loadHistory().find(x => x.id === id);
  if(!e) return;
  allData = e.rows;
  sessionStorage.setItem('mdm_csv_data', JSON.stringify(e.rows));
  sessionStorage.setItem('mdm_csv_name', e.fname);
  hideErrors();
  showStatus('success', `✓ Loaded "${e.fname}" from history (uploaded ${fmtDate(e.uploadedAt)}) — ${e.rows.length} rows`);
  renderDashboard();
  window.scrollTo({top: document.getElementById('uploadStatus').offsetTop - 20, behavior: 'smooth'});
}

/* ---------- history UI ---------- */
function renderHistory(newestId){
  const list = loadHistory();
  const body = document.getElementById('historyBody');
  if(!body) return;
  document.getElementById('historyCount').textContent = list.length ? `${list.length} saved upload${list.length>1?'s':''}` : '';

  body.innerHTML = list.length ? list.map(e => `<tr>
      <td>${esc(e.fname)}${e.id===newestId?' <span class="tbadge Updated">Just uploaded</span>':''}</td>
      <td>${fmtDate(e.uploadedAt)}</td>
      <td>${esc(e.weeks.join(', '))}</td>
      <td class="num">${e.rowCount}</td>
      <td class="hist-actions">
        <button class="btn-secondary sm" onclick="loadFromHistory('${e.id}')">Load</button>
        <button class="btn-secondary sm danger" onclick="deleteHistory('${e.id}')">Delete</button>
      </td>
    </tr>`).join('')
    : '<tr><td colspan="5" class="empty-cell">No uploads saved yet — upload a CSV above and it will appear here.</td></tr>';

  const opts = list.map(e => `<option value="${e.id}">${esc(e.fname)} — ${fmtDate(e.uploadedAt)} — ${esc(e.weeks[e.weeks.length-1]||'')}</option>`).join('');
  const base = document.getElementById('cmpBase'), cur = document.getElementById('cmpCurrent');
  const keepBase = base.value, keepCur = cur.value;
  base.innerHTML = opts; cur.innerHTML = opts;
  // Defaults: current = newest upload, baseline = the one before it
  cur.value = (!newestId && list.some(e=>e.id===keepCur)) ? keepCur : (list[0]?.id || '');
  base.value = (!newestId && list.some(e=>e.id===keepBase)) ? keepBase : (list[1]?.id || list[0]?.id || '');
  document.getElementById('cmpBtn').disabled = list.length < 2;
  document.getElementById('cmpHint').textContent = list.length < 2
    ? 'Upload at least two files to compare them.'
    : 'Each file is compared on its latest week; sources are matched on source ID.';
}

/* ---------- comparison ---------- */
function latestWeekRows(rows){
  const weeks = [...new Set(rows.map(r => r.week))].sort();
  const w = weeks[weeks.length-1];
  return { week: w, rows: rows.filter(r => r.week === w) };
}

function summarize(rows){
  const t = totalsRows(rows);
  const sum = k => t.reduce((s,r) => s + (Number(r[k])||0), 0);
  const src = sum('source_records'), gold = sum('golden_records'), pm = sum('potential_matches');
  return {
    source_records: src,
    golden_records: gold,
    ratio: gold ? src/gold : 0,
    singleton_rate: t.length ? t.reduce((s,r)=>s+(Number(r.singleton_rate)||0),0)/t.length : 0,
    potential_matches: pm,
    pm_ratio: gold ? pm/gold*100 : 0,
    sources: sourceRows(rows).length
  };
}

function runComparison(){
  const list = loadHistory();
  const base = list.find(e => e.id === document.getElementById('cmpBase').value);
  const cur = list.find(e => e.id === document.getElementById('cmpCurrent').value);
  if(!base || !cur){ setCmpMsg('error','Select two saved uploads to compare.'); return; }
  if(base.id === cur.id){ setCmpMsg('error','Baseline and current are the same upload — pick two different files.'); return; }

  const b = latestWeekRows(base.rows), c = latestWeekRows(cur.rows);
  const bMap = new Map(b.rows.map(r => [r.source_id, r]));
  const cMap = new Map(c.rows.map(r => [r.source_id, r]));
  const ids = [...new Set([...cMap.keys(), ...bMap.keys()])];

  const details = ids.map(id => {
    const p = bMap.get(id), n = cMap.get(id);
    const ref = n || p;
    const d = {
      source_id: id, source_name: ref.source_name, is_rollup: !!ref.is_rollup,
      prev_src: p ? p.source_records : null, cur_src: n ? n.source_records : null,
      prev_gold: p ? p.golden_records : null, cur_gold: n ? n.golden_records : null,
      prev_single: p ? p.singleton_rate : null, cur_single: n ? n.singleton_rate : null,
      prev_pm: p ? p.potential_matches : null, cur_pm: n ? n.potential_matches : null
    };
    d.d_src = diff(d.cur_src, d.prev_src);
    d.pct_src = pctChange(d.cur_src, d.prev_src);
    d.d_gold = diff(d.cur_gold, d.prev_gold);
    d.d_single = diff(d.cur_single, d.prev_single);
    d.d_pm = diff(d.cur_pm, d.prev_pm);
    if(!p) d.change = 'New';
    else if(!n) d.change = 'Removed';
    else if(d.d_src===0 && d.d_gold===0 && d.d_single===0 && d.d_pm===0) d.change = 'No change';
    else if(d.pct_src !== null && Math.abs(d.pct_src) > CMP_JUMP_PCT) d.change = 'Jump';
    else d.change = 'Changed';
    return d;
  });
  // biggest movers first, totals rows at the top of their group
  details.sort((x,y) => (y.is_rollup - x.is_rollup) || (Math.abs(y.d_src||0) - Math.abs(x.d_src||0)) || x.source_id.localeCompare(y.source_id));

  const bs = summarize(b.rows), cs = summarize(c.rows);
  const summary = [
    ['Source records','source_records','int'],
    ['Golden records','golden_records','int'],
    ['Source : golden ratio','ratio','ratio'],
    ['Singleton rate (avg %)','singleton_rate','pct'],
    ['Potential matches','potential_matches','int'],
    ['Potential match ratio (%)','pm_ratio','pct4'],
    ['Sources reporting','sources','int']
  ].map(([label,key,kind]) => ({label, kind, prev: bs[key], cur: cs[key], d: cs[key]-bs[key], pct: pctChange(cs[key], bs[key])}));

  const counts = {};
  details.forEach(d => counts[d.change] = (counts[d.change]||0) + 1);

  lastComparison = {
    generatedAt: new Date().toISOString(),
    base: {id: base.id, fname: base.fname, uploadedAt: base.uploadedAt, week: b.week},
    cur: {id: cur.id, fname: cur.fname, uploadedAt: cur.uploadedAt, week: c.week},
    summary, details, counts
  };
  renderComparison();
}

function renderComparison(){
  const r = lastComparison;
  document.getElementById('cmpResult').classList.remove('hidden');
  setCmpMsg('success', `Compared "${r.base.fname}" (${r.base.week}) → "${r.cur.fname}" (${r.cur.week})`);

  document.getElementById('cmpCounts').innerHTML = ['Jump','Changed','New','Removed','No change']
    .filter(k => r.counts[k])
    .map(k => `<span class="tbadge ${badgeClass(k)}">${k}: ${r.counts[k]}</span>`).join(' ');

  document.getElementById('cmpSummaryBody').innerHTML = r.summary.map(s => `<tr>
      <td>${s.label}</td>
      <td class="num">${fmtVal(s.prev, s.kind)}</td>
      <td class="num">${fmtVal(s.cur, s.kind)}</td>
      <td class="num">${deltaHtml(s.d, s.kind)}</td>
      <td class="num">${s.pct===null?'—':fmtPct(s.pct)}</td>
    </tr>`).join('');

  document.getElementById('cmpDetailBody').innerHTML = r.details.map(d => `<tr${d.is_rollup?' class="rollup-row"':''}>
      <td>${esc(d.source_id)}</td>
      <td>${esc(d.source_name)}</td>
      <td class="num">${fmtVal(d.prev_src,'int')}</td>
      <td class="num">${fmtVal(d.cur_src,'int')}</td>
      <td class="num">${deltaHtml(d.d_src,'int')}</td>
      <td class="num">${d.pct_src===null?'—':fmtPct(d.pct_src)}</td>
      <td class="num">${fmtVal(d.prev_gold,'int')}</td>
      <td class="num">${fmtVal(d.cur_gold,'int')}</td>
      <td class="num">${deltaHtml(d.d_gold,'int')}</td>
      <td class="num">${fmtVal(d.prev_single,'pct')}</td>
      <td class="num">${fmtVal(d.cur_single,'pct')}</td>
      <td class="num">${deltaHtml(d.d_single,'pp')}</td>
      <td class="num">${fmtVal(d.prev_pm,'int')}</td>
      <td class="num">${fmtVal(d.cur_pm,'int')}</td>
      <td class="num">${deltaHtml(d.d_pm,'int')}</td>
      <td><span class="tbadge ${badgeClass(d.change)}">${d.change}</span></td>
    </tr>`).join('');
}

function clearComparison(){
  lastComparison = null;
  const el = document.getElementById('cmpResult');
  if(el) el.classList.add('hidden');
}

/* ---------- downloads ---------- */
function downloadComparisonCSV(){
  const r = lastComparison; if(!r) return;
  const q = v => { const s = v===null||v===undefined ? '' : String(v); return /[",\n]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s; };
  const line = a => a.map(q).join(',');
  const out = [
    line(['MDM report comparison']),
    line(['Generated', r.generatedAt]),
    line(['Baseline file', r.base.fname, 'uploaded', r.base.uploadedAt, 'week', r.base.week]),
    line(['Current file', r.cur.fname, 'uploaded', r.cur.uploadedAt, 'week', r.cur.week]),
    '',
    line(['Metric','Baseline','Current','Change','Change %']),
    ...r.summary.map(s => line([s.label, round(s.prev), round(s.cur), round(s.d), s.pct===null?'':round(s.pct)])),
    '',
    line(['source_id','source_name','is_total_row','baseline_source_records','current_source_records','change_source_records','change_pct_source_records',
          'baseline_golden_records','current_golden_records','change_golden_records',
          'baseline_singleton_rate','current_singleton_rate','change_singleton_rate_pp',
          'baseline_potential_matches','current_potential_matches','change_potential_matches','change_flag']),
    ...r.details.map(d => line([d.source_id, d.source_name, d.is_rollup, d.prev_src, d.cur_src, d.d_src, d.pct_src===null?'':round(d.pct_src),
          d.prev_gold, d.cur_gold, d.d_gold, d.prev_single, d.cur_single, d.d_single===null?'':round(d.d_single),
          d.prev_pm, d.cur_pm, d.d_pm, d.change]))
  ].join('\r\n');
  saveFile('﻿' + out, 'text/csv;charset=utf-8', `MDM_comparison_${fileStamp(r)}.csv`);
}

function downloadComparisonHTML(){
  const r = lastComparison; if(!r) return;
  const css = `body{font-family:Segoe UI,Arial,sans-serif;font-size:12px;color:#1f2937;margin:24px;}
    h1{font-size:18px;color:#1a3a6b;margin:0 0 4px;} h2{font-size:14px;color:#1a3a6b;margin:22px 0 6px;}
    .meta{color:#6b7280;margin-bottom:2px;} table{border-collapse:collapse;width:100%;margin-top:6px;}
    th,td{border:1px solid #e2e8f0;padding:4px 8px;text-align:left;} th{background:#f1f5f9;}
    td.num,th.num{text-align:right;} tr.rollup-row td{font-weight:600;background:#f8fafc;}
    .up-arr{color:#15803d;} .dn-arr{color:#b91c1c;}
    .tbadge{display:inline-block;padding:1px 7px;border-radius:4px;font-size:11px;font-weight:600;}
    .tbadge.Updated{background:#dcfce7;color:#15803d;} .tbadge.Jump,.tbadge.Warning{background:#fef3c7;color:#b45309;}
    .tbadge.Error{background:#fee2e2;color:#b91c1c;} .tbadge.Neutral{background:#f1f5f9;color:#475569;}
    @media print{body{margin:8mm;}}`;
  const summaryRows = document.getElementById('cmpSummaryBody').innerHTML;
  const detailRows = document.getElementById('cmpDetailBody').innerHTML;
  const detailHead = document.querySelector('#cmpDetailTable thead').innerHTML;
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>MDM report comparison</title><style>${css}</style></head><body>
    <h1>MDM report comparison</h1>
    <div class="meta">Generated ${esc(fmtDate(r.generatedAt))}</div>
    <div class="meta"><b>Baseline:</b> ${esc(r.base.fname)} — week ${esc(r.base.week)} (uploaded ${esc(fmtDate(r.base.uploadedAt))})</div>
    <div class="meta"><b>Current:</b> ${esc(r.cur.fname)} — week ${esc(r.cur.week)} (uploaded ${esc(fmtDate(r.cur.uploadedAt))})</div>
    <div class="meta" style="margin-top:6px">${document.getElementById('cmpCounts').innerHTML}</div>
    <h2>Summary (totals use the all-sources rows)</h2>
    <table><thead><tr><th>Metric</th><th class="num">Baseline</th><th class="num">Current</th><th class="num">Change</th><th class="num">Change %</th></tr></thead><tbody>${summaryRows}</tbody></table>
    <h2>By source</h2>
    <table>${detailHead.replace(/<thead>|<\/thead>/g,'')}<tbody>${detailRows}</tbody></table>
    <p class="meta" style="margin-top:14px">Change flags: Jump = source records moved more than ${CMP_JUMP_PCT}%; New / Removed = source present in only one file.</p>
  </body></html>`;
  saveFile(html, 'text/html;charset=utf-8', `MDM_comparison_${fileStamp(r)}.html`);
}

function saveFile(content, type, name){
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], {type}));
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---------- helpers ---------- */
function diff(a,b){ return (a===null||b===null) ? null : round(Number(a)-Number(b)); }
function pctChange(cur,prev){ return (cur===null||prev===null||!Number(prev)) ? null : (Number(cur)-Number(prev))/Number(prev)*100; }
function round(v){ return typeof v === 'number' ? Math.round(v*10000)/10000 : v; }
function fmtVal(v,kind){
  if(v===null||v===undefined) return '—';
  if(kind==='int') return Number(v).toLocaleString('en-US');
  if(kind==='ratio') return Number(v).toFixed(3);
  if(kind==='pct4') return Number(v).toFixed(4)+'%';
  return Number(v).toFixed(2)+'%';
}
function fmtPct(p){ return (p>0?'+':'')+p.toFixed(2)+'%'; }
function deltaHtml(d,kind){
  if(d===null) return '—';
  if(d===0) return '0';
  const abs = Math.abs(d);
  const txt = kind==='int' ? abs.toLocaleString('en-US') : kind==='ratio' ? abs.toFixed(3) : kind==='pct4' ? abs.toFixed(4) : abs.toFixed(2) + (kind==='pp'?' pp':'');
  return d>0 ? `<span class="up-arr">▲ ${txt}</span>` : `<span class="dn-arr">▼ ${txt}</span>`;
}
function badgeClass(k){ return {Jump:'Jump', Changed:'Updated', New:'Updated', Removed:'Error', 'No change':'Neutral'}[k] || ''; }
function fmtDate(iso){ return new Date(iso).toLocaleString('en-GB',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}); }
function fileStamp(r){ return new Date(r.generatedAt).toISOString().slice(0,16).replace(/[:T]/g,'-'); }
function esc(s){ return String(s??'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function setCmpMsg(type,msg){
  const el = document.getElementById('cmpStatus'); if(!el) return;
  el.className = 'upload-status ' + type; el.textContent = msg; el.classList.remove('hidden');
}

document.addEventListener('DOMContentLoaded', () => renderHistory());
