/* ===== MPI Dashboard — Metrics & Trends ===== */

const REQUIRED_COLS = ['source_id','source_name','source_records','golden_records','singleton_rate','potential_matches','week','status','resource_type','singleton_records'];
const PAGE_SIZE = 15;
let allData = [], typeData = [], filteredData = [], currentPage = 1;
const chartObjs = {};

// Companies plotted by default on the four trend charts; every other source stays hidden until picked in the source filter
const DEFAULT_COMPANIES = [
  { id: 'GCBS_NG',       color: '#2563d4' },
  { id: 'HRH_EPC',       color: '#16a34a' },
  { id: 'LVPAIN_AP',     color: '#e85d2a' },
  { id: 'MAY1',          color: '#9333ea' },
  { id: 'NAEV_ECW',      color: '#0891b2' },
  { id: 'NCH_EPC',       color: '#f59e0b' },
  { id: 'NCSH_MT',       color: '#dc2626' },
  { id: 'NWOS_EPC',      color: '#059669' },
  { id: 'OAK_EGP',       color: '#d97706' },
  { id: 'OAK_EPC',       color: '#7c3aed' },
  { id: 'OrthoOHAA',     color: '#db2777' },
  { id: 'PSI_CNT',       color: '#0284c7' },
  { id: 'SHIELDS_ERAD',  color: '#65a30d' },
  { id: 'TUG_IC',        color: '#ea580c' },
  { id: 'TUHS_EPC',      color: '#0d9488' },
];
const DEFAULT_COMPANY_IDS = DEFAULT_COMPANIES.map(c => c.id);

function handleDrop(e){
  e.preventDefault();
  document.getElementById('uploadBox').classList.remove('drag-over');
  const f = e.dataTransfer.files[0];
  if(f) handleFile(f);
}

function handleFile(file){
  const nameEl = document.getElementById('uploadFileName');
  if(nameEl && file) nameEl.textContent = file.name;
  if(!file) return;
  if(!file.name.endsWith('.csv')){
    showStatus('error','Only CSV files are accepted. Please upload a .csv file.'); return;
  }
  showStatus('info','Reading file: ' + file.name + ' ...');
  const reader = new FileReader();
  reader.onload = e => processCSV(e.target.result, file.name);
  reader.readAsText(file);
}

function processCSV(text, fname, opts){
  const auto = !!(opts && opts.auto);   // true = published file loaded on page open
  const lines = text.trim().split(/\r?\n/);
  if(lines.length < 2){ showStatus('error','CSV is empty or has no data rows.'); return; }

  let headers = lines[0].split(',').map(normalizeHeader);
  let records = [];
  for(let i=1;i<lines.length;i++){
    const vals = parseCSVLine(lines[i]);
    if(vals.length === 0 || (vals.length===1 && vals[0]==='')) continue;
    const row = { _line: i+1 };
    headers.forEach((h,idx) => row[h] = (vals[idx]||'').trim().replace(/"/g,''));
    records.push(row);
  }

  // Native MDM report: every required header must be present (any letter case)
  const headerCheck = checkMDMHeaders(headers);
  if(headerCheck && headerCheck.errors.length){
    showStatus('error','Header validation failed — ' + headerCheck.missing.length + ' required column' + (headerCheck.missing.length === 1 ? '' : 's') + ' missing.');
    showErrors(headerCheck.errors); return;
  }
  let nativeRowErrors = [];
  if(headerCheck){
    const v = validateMDMRecords(records);
    nativeRowErrors = v.errors;
    records = records.filter(r => !v.badLines.has(r._line));
  }

  // Native MDM report format (snapshot_date, resource_type, source_recs, ...) -> standard schema
  const converted = convertMDMExport(headers, records);
  if(converted){ headers = converted.headers; records = converted.rows; }

  const errors = validateHeaders(headers);
  if(errors.length >= REQUIRED_COLS.length){
    // Not one of the two supported layouts at all (e.g. an unrelated export)
    errors.unshift(`This file's columns (${headers.join(', ')}) match neither the MDM weekly report format nor the standard format.`);
  }
  if(errors.length){
    showStatus('error','Validation failed — please fix the issues below.');
    showErrors(errors); return;
  }

  const rows = [];
  const rowErrors = [...nativeRowErrors];

  records.forEach(row => {
    const re = validateRow(row, row._line);
    if(re.length) rowErrors.push(...re);
    else rows.push(normalizeRow(row));
  });

  if(rowErrors.length && rows.length === 0){
    showStatus('error','All rows failed validation. Check the errors below.');
    showErrors(rowErrors); return;
  }
  if(rowErrors.length){
    showErrors(rowErrors);
    showStatus('info', `Loaded ${rows.length} valid rows from "${fname}" (${rowErrors.length} row-level warnings shown below).`);
  } else {
    hideErrors();
    showStatus('success', `✓ CSV validated and loaded: ${rows.length} rows from "${fname}"`);
  }

  // Combine with the weeks already uploaded so each new week is compared with the earlier ones
  const combine = document.getElementById('combineUploads');
  const doCombine = !auto && (!combine || combine.checked);
  const earlierWeeks = doCombine ? weeksFromHistoryNotIn(rows) : [];
  allData = doCombine ? mergeWithHistory(rows) : rows;
  if(earlierWeeks.length){
    const st = document.getElementById('uploadStatus');
    st.textContent += ' · Combined with ' + earlierWeeks.length + ' earlier week' + (earlierWeeks.length > 1 ? 's' : '') + ' from upload history (' + [...new Set(allData.map(r => r.week))].length + ' weeks compared).';
  }
  // Store for DQ page (this file only)
  // (published file isn't cached, so a reload always picks up the latest pushed version)
  if(auto) sessionStorage.removeItem('mdm_csv_data');
  else sessionStorage.setItem('mdm_csv_data', JSON.stringify(rows));
  sessionStorage.setItem('mdm_csv_name', fname);
  renderDashboard();
  // Keep every validated upload in history so it can be compared with later files
  if(!auto && typeof saveToHistory === 'function') saveToHistory(fname, rows, rowErrors.length);
  // Validated uploads also go to s3://<bucket>/uploads/mdm/ so everyone sees them on next load
  if(!auto && typeof s3Upload === 'function') s3Upload('mdm', text, fname);
}

/* ---------- Published data: shown automatically when the page opens ----------
 * Commit the CSV to reports/latest.csv and push; Vercel redeploys and everyone sees it.
 * A file uploaded in this tab takes priority until the tab is closed. */
const PUBLISHED_CSV = 'reports/latest.csv';

async function loadPublishedData(){
  try {
    const saved = sessionStorage.getItem('mdm_csv_data');
    if(saved){
      const rows = JSON.parse(saved);
      if(rows.length){
        allData = rows;
        showStatus('success', `Showing "${sessionStorage.getItem('mdm_csv_name') || 'uploaded file'}" (uploaded in this tab) — ${rows.length} rows`);
        renderDashboard();
        return;
      }
    }
  } catch(e){ /* fall through to published file */ }
  // Newest MDM report in S3 (uploads/mdm/) wins over the file committed to reports/
  const fromS3 = typeof s3Latest === 'function' ? await s3Latest('mdm') : null;
  if(fromS3){
    processCSV(fromS3.text, fromS3.name, { auto: true });
    const st = document.getElementById('uploadStatus');
    if(st && !st.classList.contains('error')) st.textContent = st.textContent.replace(/^✓ CSV validated and loaded:/, '✓ Showing latest S3 report:') + ' (upload a file to view a different one)';
    return;
  }
  try {
    const res = await fetch(PUBLISHED_CSV, { cache: 'no-cache' });
    if(!res.ok) return;                       // nothing published yet — wait for an upload
    const text = await res.text();
    if(!text.trim()) return;
    processCSV(text, 'latest.csv', { auto: true });
    const st = document.getElementById('uploadStatus');
    if(st && !st.classList.contains('error')) st.textContent = st.textContent.replace(/^✓ CSV validated and loaded:/, '✓ Showing published data:') + ' (upload a file to view a different one)';
  } catch(e){ /* offline or file:// — ignore */ }
}
document.addEventListener('DOMContentLoaded', loadPublishedData);

function escHtml(s){
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => map[c]);
}

/* Rows saved by earlier uploads, oldest first, with this upload's rows replacing the same
 * source + week + resource type. Lets week 2 be uploaded on its own and still be compared with week 1. */
function mergeWithHistory(newRows){
  const byKey = new Map();
  const key = r => [r.resource_type, r.source_id, r.week].join('|');
  let history = [];
  try { history = (typeof loadHistory === 'function' ? loadHistory() : []).slice().reverse(); } catch(e){}
  history.forEach(entry => (entry.rows || []).forEach(r => byKey.set(key(r), r)));
  newRows.forEach(r => byKey.set(key(r), r));
  return [...byKey.values()];
}

/* Weeks that exist in upload history but not in the file just uploaded */
function weeksFromHistoryNotIn(newRows){
  const have = new Set(newRows.map(r => r.week));
  const out = new Set();
  try { (typeof loadHistory === 'function' ? loadHistory() : []).forEach(e => (e.rows || []).forEach(r => { if(!have.has(r.week)) out.add(r.week); })); } catch(e){}
  return [...out];
}

function parseCSVLine(line){
  const result=[]; let cur=''; let inQ=false;
  for(let i=0;i<line.length;i++){
    const c=line[i];
    if(c==='"'){inQ=!inQ;}
    else if(c===','&&!inQ){result.push(cur);cur='';}
    else cur+=c;
  }
  result.push(cur);
  return result;
}

function validateHeaders(headers){
  const errs = [];
  REQUIRED_COLS.forEach(col => {
    if(!headers.includes(col)) errs.push(`Missing required column: "${col}"`);
  });
  return errs;
}

function validateRow(row, lineNum){
  const errs = [];
  const src = row.source_records;
  const gold = row.golden_records;
  const singleton = row.singleton_rate;
  const pm = row.potential_matches;

  if(!row.source_id) errs.push(`Row ${lineNum}: source_id is empty`);
  if(!row.source_name) errs.push(`Row ${lineNum}: source_name is empty`);
  if(!row.week) errs.push(`Row ${lineNum}: week is empty`);

  if(src===''||isNaN(Number(src))) errs.push(`Row ${lineNum}: source_records must be a number (got "${src}")`);
  if(gold===''||isNaN(Number(gold))) errs.push(`Row ${lineNum}: golden_records must be a number (got "${gold}")`);
  if(pm===''||isNaN(Number(pm))) errs.push(`Row ${lineNum}: potential_matches must be a number (got "${pm}")`);

  const sVal = parseFloat(singleton);
  if(isNaN(sVal)) errs.push(`Row ${lineNum}: singleton_rate must be a number (got "${singleton}")`);
  else if(sVal<0||sVal>100) errs.push(`Row ${lineNum}: singleton_rate must be between 0 and 100 (got ${sVal})`);

  if(Number(src)>0 && Number(gold)>Number(src))
    errs.push(`Row ${lineNum}: golden_records (${gold}) cannot exceed source_records (${src})`);

  const validStatus = ['updated','jump','no change',''];
  if(!validStatus.includes((row.status||'').toLowerCase()))
    errs.push(`Row ${lineNum}: status "${row.status}" not recognised (expected: Updated, Jump, No change)`);

  return errs;
}

// Accept any casing (patient, PATIENT, ...) and store the canonical form
function canonicalResourceType(v){
  const t = String(v||'').trim();
  return ['Patient','Practitioner','Organization'].find(x => x.toLowerCase() === t.toLowerCase()) || t;
}

function normalizeRow(row){
  return {
    source_id: row.source_id,
    source_name: row.source_name,
    source_records: parseInt(row.source_records)||0,
    golden_records: parseInt(row.golden_records)||0,
    singleton_rate: parseFloat(row.singleton_rate)||0,
    potential_matches: parseInt(row.potential_matches)||0,
    singleton_records: parseInt(row.singleton_records)||0,
    week: row.week,
    status: row.status,
    resource_type: canonicalResourceType(row.resource_type),
    is_rollup: row.is_rollup === true || String(row.is_rollup).toLowerCase() === 'true',
    group: row.group || ''
  };
}

function showStatus(type, msg){
  const el = document.getElementById('uploadStatus');
  el.className = 'upload-status ' + type;
  el.textContent = msg;
  el.classList.remove('hidden');
}

function showErrors(errs){
  const el = document.getElementById('validationErrors');
  el.innerHTML = `<h4>&#9888; Validation issues (${errs.length})</h4><ul>${errs.map(e=>`<li>${e}</li>`).join('')}</ul>`;
  el.classList.remove('hidden');
}

function hideErrors(){
  document.getElementById('validationErrors').classList.add('hidden');
}

/* ===== RENDER DASHBOARD ===== */
function renderDashboard(){
  populateWeekFilter();
  populateSourceFilter();
  applyFilters();
  show('toolbar','kpiRow','kpiNote','chartsRow','tableCard');
}

function show(...ids){ ids.forEach(id=>{ const el=document.getElementById(id); if(el) el.classList.remove('hidden'); }); }

function populateWeekFilter(){
  const weeks = [...new Set(allData.map(r=>r.week))].sort();
  const sel = document.getElementById('filterWeek');
  sel.innerHTML = '<option value="all">Week: All weeks</option>';
  weeks.forEach(w => { const o=document.createElement('option'); o.value=w; o.textContent='Week: '+w; sel.appendChild(o); });
}

function populateSourceFilter(){
  const sel = document.getElementById('sourceSelect');
  if(!sel) return;
  const prev = sel.value;
  const seen = new Map();
  allData.forEach(r => { if(!r.is_rollup && !seen.has(r.source_id)) seen.set(r.source_id, r.source_name); });
  sel.innerHTML = '<option value="all">All sources</option>';
  [...seen.entries()].sort((a,b)=>String(a[1]).localeCompare(String(b[1]))).forEach(([id,name])=>{
    const o = document.createElement('option');
    o.value = id;
    o.textContent = name + ' (' + id + ')';
    sel.appendChild(o);
  });
  if(seen.has(prev)) sel.value = prev;
}

function applyFilters(){
  const sourceSel = document.getElementById('sourceSelect')?.value||'all';
  const week = document.getElementById('filterWeek')?.value||'all';
  const status = document.getElementById('filterStatus')?.value||'all';
  const search = (document.getElementById('searchInput')?.value||'').toLowerCase();
  const sortBy = document.getElementById('sortSelect')?.value||'source_records';

  // Everything below (KPIs, charts, table) works on one resource type at a time
  typeData = allData.filter(r => String(r.resource_type||'').trim().toLowerCase() === selectedResourceType().toLowerCase());

  filteredData = typeData.filter(r => {
    if(week!=='all' && r.week!==week) return false;
    if(sourceSel!=='all' && r.source_id!==sourceSel) return false;
    if(status!=='all' && r.status.toLowerCase()!==status.toLowerCase()) return false;
    if(search && !r.source_name.toLowerCase().includes(search) && !r.source_id.toLowerCase().includes(search)) return false;
    return true;
  }).sort((a,b)=> b[sortBy]-a[sortBy]);

  document.getElementById('sourceCount').textContent = `${filteredData.length} of ${typeData.length} sources`;
  currentPage = 1;
  // Trend data: resource type only. Week must never filter the trend charts.
  const trendData = typeData;
  renderKPIs();
  renderCharts(trendData);
  renderTable();
}

function selectedResourceType(){
  return document.getElementById('filterResourceType')?.value || 'Patient';
}

function renderKPIs(){
  // Weeks come from ALL data (every resource type) so the previous week is always found
  const allWeeks = [...new Set(allData.map(r => r.week))].sort();
  const latestWeek = allWeeks[allWeeks.length - 1];
  const prevWeek = allWeeks.length >= 2 ? allWeeks[allWeeks.length - 2] : null;

  // typeData is already filtered to the selected resource type
  const latest = totalsRows(typeData.filter(r => r.week === latestWeek));
  const prev = prevWeek ? totalsRows(typeData.filter(r => r.week === prevWeek)) : [];
  const hasPrev = prev.length > 0;

  const sum = (arr,k) => arr.reduce((s,r)=>s+(Number(r[k])||0),0);

  const srcNow = sum(latest,'source_records');
  const goldNow = sum(latest,'golden_records');
  const pmNow = sum(latest,'potential_matches');
  // Singleton rate = singleton records / golden records (not an average of the singleton_rate column)
  const singletonRecordsNow = sum(latest,'singleton_records');
  const singletonRateNow = goldNow > 0 ? (singletonRecordsNow / goldNow) * 100 : 0;
  const ratio = goldNow>0 ? (srcNow/goldNow).toFixed(2) : '—';

  document.getElementById('kpi-src').textContent = fmt(srcNow);
  document.getElementById('kpi-gold').textContent = fmt(goldNow);
  document.getElementById('kpi-ratio').textContent = ratio;
  document.getElementById('kpi-singleton').textContent = singletonRateNow.toFixed(2)+'%';
  document.getElementById('kpi-pm').textContent = fmt(pmNow);

  const labelNow = weekLabel(latestWeek);
  const kpiIds = ['kpi-src','kpi-gold','kpi-ratio','kpi-singleton','kpi-pm'];

  // Previous week: the one before the latest in this file; if the file holds a single week,
  // fall back to the most recent earlier week saved in this browser's upload history.
  let prevRows = prev, labelPrev = prevWeek ? weekLabel(prevWeek) : '';
  if(!hasPrev){
    const h = earlierWeekFromHistory(latestWeek);
    if(h){ prevRows = h.rows; labelPrev = weekLabel(h.week); }
  }

  if(!prevRows.length){
    kpiIds.forEach(id => setKpiCompare(id, null));
    return;
  }

  const srcPrev = sum(prevRows,'source_records');
  const goldPrev = sum(prevRows,'golden_records');
  const pmPrev = sum(prevRows,'potential_matches');
  const singletonRatePrev = goldPrev > 0 ? (sum(prevRows,'singleton_records') / goldPrev) * 100 : 0;
  const ratioNow = goldNow > 0 ? srcNow / goldNow : 0;
  const ratioPrev = goldPrev > 0 ? srcPrev / goldPrev : 0;

  const cmp = { labelNow, labelPrev };
  const count = { show:fmt, diff:n=>fmt(Math.abs(n)), pct:true };
  setKpiCompare('kpi-src', Object.assign({now:srcNow, prev:srcPrev}, count, cmp));
  setKpiCompare('kpi-gold', Object.assign({now:goldNow, prev:goldPrev}, count, cmp));
  // Source : Golden — a lower ratio means better deduplication, so colours are inverted
  setKpiCompare('kpi-ratio', Object.assign({now:ratioNow, prev:ratioPrev, show:v=>fmtDec(v,2), diff:n=>fmtDec(Math.abs(n),3), pct:false, invert:true}, cmp));
  setKpiCompare('kpi-singleton', Object.assign({now:singletonRateNow, prev:singletonRatePrev, show:v=>fmtDec(v,2)+'%', diff:n=>fmtDec(Math.abs(n),2)+' pts', pct:false}, cmp));
  setKpiCompare('kpi-pm', Object.assign({now:pmNow, prev:pmPrev}, count, cmp));
}

/* Most recent week earlier than `latestWeek` for the selected resource type, from saved uploads. */
function earlierWeekFromHistory(latestWeek){
  if(typeof loadHistory !== 'function') return null;
  const type = selectedResourceType().toLowerCase();
  let best = null;
  try {
    loadHistory().forEach(entry => (entry.rows || []).forEach(r => {
      if(String(r.resource_type||'').trim().toLowerCase() !== type) return;
      if(r.week < latestWeek && (!best || r.week > best.week)) best = { week: r.week, rows: [] };
    }));
    if(!best) return null;
    // Use the newest saved upload that contains that week
    const entries = loadHistory().slice().sort((a,b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)));
    for(const entry of entries){
      const rows = (entry.rows || []).filter(r => r.week === best.week && String(r.resource_type||'').trim().toLowerCase() === type);
      if(rows.length){ best.rows = totalsRows(rows); break; }
    }
  } catch(e){ return null; }
  return best && best.rows.length ? best : null;
}

/* Fills a headline card: this week vs previous week, the difference and its direction.
 * c = null when there is no previous week. */
function setKpiCompare(id, c){
  const box = document.getElementById(id + '-c');
  const el = document.getElementById(id + '-d');
  if(!box || !el) return;
  box.textContent = '';
  if(!c){
    el.textContent = '— First week';
    el.className = 'delta neu';
    return;
  }
  const diff = c.now - c.prev;
  const text = c.diff(diff);
  const zero = Math.abs(diff) < 1e-9 || text.replace(/[^0-9]/g,'').replace(/0/g,'') === '';
  [['This week (' + c.labelNow + ')', c.show(c.now)], ['Previous week (' + c.labelPrev + ')', c.show(c.prev)]].forEach(([k, v]) => {
    const row = document.createElement('div'); row.className = 'cmp-row';
    const s = document.createElement('span'); s.textContent = k;
    const b = document.createElement('b'); b.textContent = v;
    row.append(s, b); box.appendChild(row);
  });
  if(zero){
    el.textContent = '— No change vs last week';
    el.className = 'delta neu';
    return;
  }
  const up = diff > 0;
  const good = c.invert ? !up : up;
  el.textContent = (up ? '▲ ' : '▼ ') + text + ' vs last week';
  el.className = 'delta ' + (good ? 'up' : 'dn');
}

function fmt(n){ return Number(n).toLocaleString('en-US'); }
function fmtDec(n, d){ return Number(n).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d}); }

// Chart text/axis colours follow the light/dark theme (js/theme.js)
function applyChartTheme(){
  if(typeof Chart === 'undefined') return;
  Chart.defaults.locale = 'en-US';
  Chart.defaults.color = themeColor('--chart-text');
  Chart.defaults.borderColor = themeColor('--chart-grid');
}
window.addEventListener('themechange', () => {
  if(!typeData.length) return;
  renderCharts(typeData);
});

/* Show/clear a "no data" message in a canvas's parent card. Returns true when empty. */
function toggleNoData(canvas, isEmpty){
  const parent = canvas.parentElement;
  let msg = parent.querySelector('.no-data-msg');
  if(isEmpty){
    if(!msg){
      msg = document.createElement('p');
      msg.className = 'no-data-msg';
      msg.textContent = 'No data available for the selected filters.';
      parent.appendChild(msg);
    }
    canvas.style.display = 'none';
  } else {
    if(msg) msg.remove();
    canvas.style.display = '';
  }
  return isEmpty;
}

const SRC_COLORS = ['#1a6fd1','#e8a400','#16a06e','#8b5cf6','#e11d74','#0891b2','#ea580c','#64748b'];
// Unique colour per source: curated palette first, then golden-angle hues so no two sources repeat
function srcColor(i){
  if(i < SRC_COLORS.length) return SRC_COLORS[i];
  const k = i - SRC_COLORS.length;
  const hue = Math.round((k * 137.508 + 20) % 360);
  return `hsl(${hue}, ${65 + (k % 3) * 10}%, ${42 + (k % 4) * 6}%)`;
}

/* Compact axis numbers: 1.6M, 800k, 0 */
function shortNum(v){
  const a = Math.abs(v);
  if(a >= 1e6) return (v/1e6).toFixed(a % 1e6 === 0 ? 0 : 1) + 'M';
  if(a >= 1e3) return (v/1e3).toFixed(0) + 'k';
  return String(v);
}

/* Week axis labels: "Week 1" from "2026-10-19 (Week 1)", otherwise the raw week text */
function weekLabel(w){
  const m = /\((.+)\)\s*$/.exec(w);
  return m ? m[1] : w;
}

function makeLineChart(key, canvasId, labels, datasets, yOpts, tipFmt, legend){
  const ctx = document.getElementById(canvasId);
  if(!ctx) return;
  if(chartObjs[key]){ chartObjs[key].destroy(); chartObjs[key] = null; }
  if(toggleNoData(ctx, labels.length === 0)) return;
  const grid = themeColor('--chart-grid');
  chartObjs[key] = new Chart(ctx,{
    type:'line',
    data:{ labels, datasets: datasets.map(d => Object.assign({
      borderWidth:2, tension:0, pointRadius:3.5, pointHoverRadius:5, fill:false, clip:false,
      pointBackgroundColor:d.borderColor
    }, d)) },
    options:{
      responsive:true, maintainAspectRatio:false,
      interaction:{mode:'index',intersect:false},
      plugins:{
        legend: legend ? {position:'bottom',align:'start',labels:{usePointStyle:true,pointStyle:'rect',boxWidth:10,boxHeight:10,padding:14,font:{size:11}}} : {display:false},
        tooltip:{callbacks:{label:c => c.dataset.label + ': ' + tipFmt(c.parsed.y)}}
      },
      scales:{
        y: Object.assign({grid:{color:grid},border:{display:false},ticks:{font:{size:10}}}, yOpts),
        x:{grid:{display:false},border:{display:false},ticks:{font:{size:10}}}
      }
    }
  });
}

/* The four dashboard comparisons. data = selected resource type, ALL weeks. */
function renderCharts(data){
  applyChartTheme();
  const weeks = [...new Set(data.map(r=>r.week))].sort();
  let labels = weeks.map(weekLabel);
  if(new Set(labels).size !== labels.length) labels = weeks.map((w,i) => 'Week ' + (i+1));

  // Per-source series (rollup rows excluded)
  const perSource = sourceRows(data);
  const labelOf = r => String(r.source_name).includes(' — ') ? String(r.source_name).split(' — ').slice(1).join(' — ') : r.source_name;
  const allNames = [...new Set(perSource.map(labelOf))];
  const selId = document.getElementById('sourceSelect')?.value || 'all';

  // Which lines to draw:
  //  default: the 15 DEFAULT_COMPANIES (those present in the data), also when one of them is picked
  //  custom : a non-default source picked in the filter -> only that source
  //  legacy : none of the 15 exist in the data -> every source, as before
  const matchCo = (r, id) => r.source_id === id || r.source_name === id || labelOf(r) === id;
  const selRows = selId === 'all' ? [] : perSource.filter(r => r.source_id === selId);
  const selIsDefault = DEFAULT_COMPANIES.some(c => selRows.some(r => matchCo(r, c.id)));
  const defaultsPresent = DEFAULT_COMPANIES.filter(c => perSource.some(r => matchCo(r, c.id)));
  let groups;
  if(selId !== 'all' && !selIsDefault){
    const selNames = [...new Set(selRows.map(labelOf))];
    groups = selNames.map(n => ({
      label:n, color: selNames.length === 1 ? '#2563d4' : srcColor(allNames.indexOf(n)),
      match: r => r.source_id === selId && labelOf(r) === n
    }));
  } else if(defaultsPresent.length){
    groups = defaultsPresent.map(c => ({ label:c.id, color:c.color, match: r => matchCo(r, c.id) }));
  } else {
    const names = selId === 'all' ? allNames : [...new Set(selRows.map(labelOf))];
    groups = names.map(n => ({ label:n, color:srcColor(allNames.indexOf(n)), match: r => labelOf(r) === n }));
  }
  const series = fn => groups.map(g => ({
    label:g.label, borderColor:g.color,
    data: weeks.map(w => {
      const rows = perSource.filter(r => r.week === w && g.match(r));
      return rows.length ? fn(rows) : null;
    })
  }));
  const sum = (rows,k) => rows.reduce((s,r)=>s+(Number(r[k])||0),0);
  const usFmt = v => Number(v).toLocaleString('en-US');

  makeLineChart('src','srcChart',labels, series(rows => sum(rows,'source_records')),
    {beginAtZero:true,ticks:{callback:shortNum,font:{size:10}}}, usFmt, true);
  makeLineChart('gold','goldChart',labels, series(rows => sum(rows,'golden_records')),
    {beginAtZero:true,ticks:{callback:shortNum,font:{size:10}}}, usFmt, true);
  makeLineChart('sing','singChart',labels, series(rows => {
      const g = sum(rows,'golden_records');
      return g > 0 ? parseFloat((sum(rows,'singleton_records')/g*100).toFixed(2)) : 0;
    }),
    {min:0,max:100,ticks:{stepSize:20,callback:v => v + '%',font:{size:10}}}, v => Number(v).toFixed(1) + '%', true);

  // Potential matches: always the full all-sources total (ALL row), one line, regardless of company filter
  const pm = weeks.map(w => sum(totalsRows(data.filter(r=>r.week===w)),'potential_matches'));
  makeLineChart('pm','pmCountChart',labels,
    [{label:'Potential Matches',borderColor:'#d94a38',data:pm}],
    {beginAtZero:false,ticks:{callback:usFmt,font:{size:10}}}, usFmt, false);
}

function renderTable(){
  const body = document.getElementById('tableBody');
  const start = (currentPage-1)*PAGE_SIZE;
  const page = filteredData.slice(start, start+PAGE_SIZE);
  const totalPages = Math.max(1,Math.ceil(filteredData.length/PAGE_SIZE));
  document.getElementById('pageInfo').textContent = `Page ${currentPage} of ${totalPages}`;

  // Previous-week row for each source/week, so every field can show its variation
  const weeks = [...new Set(typeData.map(r=>r.week))].sort();
  const prevRow = {};
  typeData.forEach(r=>{
    const idx = weeks.indexOf(r.week);
    if(idx>0){
      const prev = typeData.find(x=>x.source_id===r.source_id && x.week===weeks[idx-1]);
      if(prev) prevRow[r.source_id+'_'+r.week] = prev;
    }
  });
  const singletonPct = r => r.golden_records > 0 ? r.singleton_records / r.golden_records * 100 : 0;
  const varCell = (cur, prev, show) => {
    if(prev === undefined || prev === null) return '—';
    const d = cur - prev;
    const t = show(Math.abs(d));
    if(Math.abs(d) < 1e-9 || t.replace(/[^0-9]/g,'').replace(/0/g,'') === '') return '—';
    return d > 0 ? '<span class="up-arr">▲</span> ' + t : '<span class="dn-arr">▼</span> ' + t;
  };

  body.innerHTML = page.map(r=>{
    const p = prevRow[r.source_id+'_'+r.week];
    const statusKey = escHtml(r.status).replace(/\s+/g,'.');
    return `<tr>
      <td>${escHtml(r.source_id)}</td>
      <td>${escHtml(r.source_name)}</td>
      <td class="num">${fmt(r.source_records)}</td>
      <td class="num">${varCell(r.source_records, p && p.source_records, fmt)}</td>
      <td class="num">${fmt(r.golden_records)}</td>
      <td class="num">${varCell(r.golden_records, p && p.golden_records, fmt)}</td>
      <td class="num">${singletonPct(r).toFixed(2)}%</td>
      <td class="num">${varCell(singletonPct(r), p && singletonPct(p), n => n.toFixed(2) + ' pts')}</td>
      <td class="num">${fmt(r.potential_matches)}</td>
      <td class="num">${varCell(r.potential_matches, p && p.potential_matches, fmt)}</td>
      <td>${escHtml(r.week)}</td>
      <td><span class="tbadge ${statusKey}">${escHtml(r.status||'—')}</span></td>
    </tr>`;
  }).join('');
}

function changePage(dir){
  const totalPages = Math.max(1,Math.ceil(filteredData.length/PAGE_SIZE));
  currentPage = Math.min(totalPages, Math.max(1, currentPage+dir));
  renderTable();
}

function downloadReport(type, format = 'csv') {
  if (allData.length === 0) {
    alert('Please upload a CSV file first to generate a report.');
    return;
  }

  if (type === 'comparison' && new Set(allData.map(r => r.week)).size < 2) {
    alert('Upload at least two weeks of data to generate the comparison report.');
    return;
  }

  const dateStr = new Date().toISOString().slice(0, 10);
  const headers = Object.keys(allData[0]);
  const weeks   = [...new Set(allData.map(r => r.week))].sort();
  const latestWeek = weeks[weeks.length - 1];

  // Decide which rows to include
  let rows = [];
  if (type === 'daily') {
    rows = allData.filter(r => r.week === latestWeek);
  } else {
    rows = allData;
  }

  if (format === 'csv' && type === 'comparison') {
    const blob = new Blob([buildComparisonCsv()], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'MDM_comparison_report_' + dateStr + '.csv';
    a.click();
    URL.revokeObjectURL(a.href);
    return;
  }

  if (format === 'csv') {
    const csvContent = [
      headers.join(','),
      ...rows.map(r => headers.map(h => {
        const val = String(r[h] ?? '');
        return val.includes(',') ? '"' + val + '"' : val;
      }).join(','))
    ].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'MDM_' + type + '_report_' + dateStr + '.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  if (format === 'doc') {
    const html = buildReportDoc(type);
    const blob = new Blob(['﻿' + html], { type: 'application/msword' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'MDM_' + type + '_report_' + dateStr + '.doc';
    a.click();
    URL.revokeObjectURL(a.href);
  }
}
