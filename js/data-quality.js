/* ===== MPI Dashboard — Data Quality Page ===== */

const REQUIRED_COLS = ['source_id','source_name','source_records','golden_records','singleton_rate','potential_matches','week','status','resource_type','singleton_records'];
const VALID_RESOURCE_TYPES = ['Patient','Practitioner','Organization'];
const NUMERIC_COLS = ['source_records','golden_records','singleton_rate','potential_matches','singleton_records'];

let dqData = [], dqIssues = [], filteredIssues = [];

function handleDrop(e){
  e.preventDefault();
  document.getElementById('uploadBox').classList.remove('drag-over');
  const f = e.dataTransfer.files[0];
  if(f) handleFileDQ(f);
}

function handleFileDQ(file){
  if(!file) return;
  if(!file.name.endsWith('.csv')){ showStatus('error','Only CSV files are accepted.'); return; }
  showStatus('info','Reading: ' + file.name + ' ...');
  const reader = new FileReader();
  reader.onload = e => processCSVDQ(e.target.result, file.name);
  reader.readAsText(file);
}

function processCSVDQ(text, fname){
  const lines = text.trim().split(/\r?\n/);
  if(lines.length<2){ showStatus('error','CSV is empty or has no data rows.'); return; }
  let headers = lines[0].split(',').map(normalizeHeader);
  // Data quality report (area/check/issue_type/records/denominator...) is handled by dq-report.js
  if(isDQReportHeaders(headers)){ processDQReport(lines, fname); return; }
  const headerCheck = checkMDMHeaders(headers);
  if(headerCheck && headerCheck.errors.length){
    showStatus('error','Header validation failed — ' + headerCheck.errors.filter(e => e.startsWith('Missing') || e.startsWith('Duplicate')).join('; '));
    return;
  }
  let rows=[];
  for(let i=1;i<lines.length;i++){
    const vals = parseCSVLine(lines[i]);
    if(!vals.length||(vals.length===1&&vals[0]==='')) continue;
    const row={ _line: i+1 };
    headers.forEach((h,idx)=>row[h]=(vals[idx]||'').trim().replace(/"/g,''));
    rows.push(row);
  }
  // Native MDM report format (snapshot_date, resource_type, source_recs, ...) -> standard schema
  const converted = convertMDMExport(headers, rows);
  if(converted){ headers = converted.headers; rows = converted.rows; }

  const missing = REQUIRED_COLS.filter(c=>!headers.includes(c));
  if(missing.length){
    showStatus('error','Missing required columns: ' + missing.join(', '));
    return;
  }
  dqData = rows.map(r=>({
    source_id: r.source_id,
    source_name: r.source_name,
    source_records: r.source_records,
    golden_records: r.golden_records,
    singleton_rate: r.singleton_rate,
    potential_matches: r.potential_matches,
    week: r.week,
    status: r.status,
    resource_type: r.resource_type,
    singleton_records: r.singleton_records,
    is_rollup: r.is_rollup === true || String(r.is_rollup).toLowerCase() === 'true',
    group: r.group || '',
    _line: r._line,
    _raw: r
  }));
  showStatus('success', `✓ Loaded ${dqData.length} rows from "${fname}"`);
  runDQAnalysis();
}

// Values may be strings (fresh upload) or numbers (loaded from the metrics page via sessionStorage)
function isBlank(v){ return v===undefined || v===null || String(v).trim()===''; }

function parseCSVLine(line){
  const result=[]; let cur=''; let inQ=false;
  for(let i=0;i<line.length;i++){
    const c=line[i];
    if(c==='"'){inQ=!inQ;}
    else if(c===','&&!inQ){result.push(cur);cur='';}
    else cur+=c;
  }
  result.push(cur); return result;
}

function runDQAnalysis(){
  dqIssues = [];
  let missingCount = 0;

  // Check each row
  dqData.forEach((row, idx)=>{
    const lineNum = row._line || idx+2;

    // Required field presence (status may be blank — same rule as the metrics page)
    REQUIRED_COLS.forEach(col=>{
      if(col==='status') return;
      if(isBlank(row[col])){
        missingCount++;
        dqIssues.push({row:lineNum, source_id:row.source_id||'—', source_name:row.source_name||'—', week:row.week||'—', severity:'Error', issue:`Missing value in column "${col}"`});
      }
    });

    // Numeric checks
    NUMERIC_COLS.forEach(col=>{
      const val = row[col];
      if(val!==undefined && val!=='' && isNaN(Number(val))){
        dqIssues.push({row:lineNum, source_id:row.source_id||'—', source_name:row.source_name||'—', week:row.week||'—', severity:'Error', issue:`"${col}" must be numeric (got "${val}")`});
      }
    });

    // singleton_rate range
    const sr = parseFloat(row.singleton_rate);
    if(!isNaN(sr) && (sr<0||sr>100)){
      dqIssues.push({row:lineNum, source_id:row.source_id, source_name:row.source_name, week:row.week, severity:'Error', issue:`singleton_rate out of range: ${sr} (must be 0–100)`});
    }

    // singleton_records must be a non-negative integer (non-numeric values are reported above)
    const sRec = row.singleton_records;
    if(!isBlank(sRec) && !isNaN(Number(sRec)) && (!Number.isInteger(Number(sRec)) || Number(sRec)<0)){
      dqIssues.push({row:lineNum, source_id:row.source_id||'—', source_name:row.source_name||'—', week:row.week||'—', severity:'Error', issue:`singleton_records must be a non-negative integer (got "${sRec}")`});
    }
    // singleton_records cannot exceed golden_records
    const sr2 = Number(sRec), g2 = Number(row.golden_records);
    if(!isBlank(sRec) && !isBlank(row.golden_records) && !isNaN(sr2) && !isNaN(g2) && sr2>g2){
      dqIssues.push({row:lineNum, source_id:row.source_id||'—', source_name:row.source_name||'—', week:row.week||'—', severity:'Error', issue:`singleton_records (${sr2}) exceeds golden_records (${g2})`});
    }

    // Golden > source anomaly
    const src = parseInt(row.source_records);
    const gold = parseInt(row.golden_records);
    if(!isNaN(src)&&!isNaN(gold)&&src>0&&gold>src){
      dqIssues.push({row:lineNum, source_id:row.source_id, source_name:row.source_name, week:row.week, severity:'Error', issue:`golden_records (${gold}) exceeds source_records (${src})`});
    }

    // Status value check
    const validStatus=['updated','jump','no change',''];
    if(row.status!==undefined && !validStatus.includes((row.status||'').toLowerCase())){
      dqIssues.push({row:lineNum, source_id:row.source_id, source_name:row.source_name, week:row.week, severity:'Warning', issue:`Unrecognised status value: "${row.status}"`});
    }

    // resource_type value check (blank is reported by the missing-value check)
    if(!isBlank(row.resource_type) && !VALID_RESOURCE_TYPES.some(t => t.toLowerCase() === String(row.resource_type).trim().toLowerCase())){
      dqIssues.push({row:lineNum, source_id:row.source_id, source_name:row.source_name, week:row.week, severity:'Warning', issue:`Invalid resource_type: "${row.resource_type}" (must be Patient, Practitioner, or Organization)`});
    }

    // Duplicate source+week
  });

  // Duplicate check
  const seen={};
  dqData.forEach((row,idx)=>{
    const key=row.source_id+'||'+row.week;
    if(seen[key]!==undefined){
      dqIssues.push({row:idx+2, source_id:row.source_id, source_name:row.source_name, week:row.week, severity:'Warning', issue:`Duplicate entry: source_id "${row.source_id}" appears more than once for week "${row.week}"`});
    } else seen[key]=idx;
  });

  const errorRows = [...new Set(dqIssues.filter(i=>i.severity==='Error').map(i=>i.row))];
  const issueRows = [...new Set(dqIssues.map(i=>i.row))];
  const validRows = dqData.length - issueRows.length;
  const score = dqData.length>0 ? Math.max(0,Math.round((validRows/dqData.length)*100)) : 0;

  renderKPIs(validRows, issueRows.length, missingCount, score);
  renderCompleteness();
  renderRules(errorRows.length);
  renderIssuesTable();
  renderFieldStats();
  showCards();
}

function renderKPIs(valid, issues, missing, score){
  document.getElementById('dq-total').textContent = dqData.length;
  document.getElementById('dq-valid').textContent = valid;
  document.getElementById('dq-valid-pct').textContent = dqData.length>0?((valid/dqData.length)*100).toFixed(1)+'% rows valid':'—';
  document.getElementById('dq-valid-pct').className = 'delta '+(valid===dqData.length?'up':'neu');
  document.getElementById('dq-issues').textContent = issues;
  document.getElementById('dq-issues-pct').textContent = issues>0?((issues/dqData.length)*100).toFixed(1)+'% rows affected':'None';
  document.getElementById('dq-issues-pct').className = 'delta '+(issues===0?'up':'dn');
  document.getElementById('dq-missing').textContent = missing;
  document.getElementById('dq-missing-d').textContent = missing===0?'All fields complete':'field values missing';
  document.getElementById('dq-missing-d').className = 'delta '+(missing===0?'up':'dn');
  document.getElementById('dq-score').textContent = score+'%';
  document.getElementById('dq-score-d').textContent = score>=95?'Excellent':score>=80?'Good':score>=60?'Fair':'Needs attention';
  document.getElementById('dq-score-d').className = 'delta '+(score>=95?'up':score>=80?'neu':'dn');
}

function renderCompleteness(){
  const el = document.getElementById('completenessChart');
  if(!el) return;
  let html='';
  REQUIRED_COLS.forEach(col=>{
    const filled = dqData.filter(r=>!isBlank(r[col])).length;
    const pct = dqData.length>0 ? Math.round((filled/dqData.length)*100) : 0;
    const color = pct===100?'#16a34a':pct>=90?'#f59e0b':'#e85d2a';
    html+=`<div class="comp-row">
      <span class="comp-label">${col}</span>
      <div class="comp-track"><div class="comp-fill" style="width:${pct}%;background:${color}"></div></div>
      <span class="comp-pct" style="color:${color}">${pct}%</span>
    </div>`;
  });
  el.innerHTML=html;
}

function renderRules(errorCount){
  const el = document.getElementById('rulesPanel');
  if(!el) return;

  const hasData = dqData.length>0;
  const badResType = dqIssues.filter(i=>i.issue.startsWith('Invalid resource_type')).length;
  const duplicates = dqIssues.filter(i=>i.issue.startsWith('Duplicate')).length;
  const badStatus = dqIssues.filter(i=>i.issue.includes('status')).length;
  const goldExceed = dqIssues.filter(i=>i.issue.startsWith('golden_records')).length;
  const srRange = dqIssues.filter(i=>i.issue.includes('singleton_rate out')).length;
  const numericErrors = dqIssues.filter(i=>i.issue.includes('must be numeric') || i.issue.includes('non-negative integer')).length;
  const singletonExceed = dqIssues.filter(i=>i.issue.startsWith('singleton_records') && i.issue.includes('exceeds')).length;
  const missingErrors = dqIssues.filter(i=>i.issue.includes('Missing value')).length;

  const rules=[
    {name:'Required columns present', desc:'All 10 required columns exist in the file', pass:true},
    {name:'No missing required values', desc:`${missingErrors} missing values found across required columns`, pass:missingErrors===0, warn:missingErrors>0},
    {name:'Numeric field types', desc:`${numericErrors} fields with non-numeric values in source_records, golden_records, singleton_rate, potential_matches, singleton_records`, pass:numericErrors===0, warn:numericErrors>0},
    {name:'Singleton rate range (0–100)', desc:`${srRange} rows with singleton_rate outside 0–100`, pass:srRange===0, warn:srRange>0},
    {name:'Golden ≤ source records', desc:`${goldExceed} rows where golden_records exceeds source_records`, pass:goldExceed===0, warn:goldExceed>0},
    {name:'Singleton records ≤ golden records', desc:`${singletonExceed} rows where singleton_records cannot exceed golden_records`, pass:singletonExceed===0, warn:singletonExceed>0},
    {name:'Valid status values', desc:`${badStatus} rows with unrecognised status values`, pass:badStatus===0, warn:badStatus>0},
    {name:'Valid resource_type', desc:`${badResType} rows where resource_type is not Patient, Practitioner, or Organization`, pass:badResType===0, warn:badResType>0},
    {name:'No duplicate source+week', desc:`${duplicates} duplicate source_id + week combinations`, pass:duplicates===0, warn:duplicates>0},
    {name:'Positive record counts', desc:'All source_records and golden_records are ≥ 0', pass:dqData.every(r=>parseInt(r.source_records)>=0&&parseInt(r.golden_records)>=0)},
  ];

  el.innerHTML = rules.map(r=>`<div class="rule-row">
    <span class="rule-icon">${r.pass?'✅':'⚠️'}</span>
    <div>
      <div class="rule-name">${r.name}</div>
      <div class="rule-desc">${r.desc}</div>
    </div>
    <span class="rule-badge ${r.pass?'pass':r.warn?'warn':'fail'}">${r.pass?'Pass':r.warn?'Warning':'Fail'}</span>
  </div>`).join('');
}

function renderIssuesTable(){
  filteredIssues = [...dqIssues];
  renderDQTableRows();
  const noIssues = document.getElementById('dqNoIssues');
  if(noIssues) noIssues.classList.toggle('hidden', dqIssues.length>0);
}

function filterDQTable(){
  const search=(document.getElementById('dqSearch')?.value||'').toLowerCase();
  const sev=(document.getElementById('dqSeverity')?.value||'all');
  filteredIssues=dqIssues.filter(i=>{
    if(sev!=='all'&&i.severity!==sev) return false;
    if(search&&!i.source_name.toLowerCase().includes(search)&&!i.source_id.toLowerCase().includes(search)) return false;
    return true;
  });
  renderDQTableRows();
}

function renderDQTableRows(){
  const body=document.getElementById('dqTableBody');
  if(!body) return;
  body.innerHTML=filteredIssues.map(i=>`<tr>
    <td>${i.row}</td>
    <td>${i.source_id}</td>
    <td>${i.source_name}</td>
    <td>${i.week}</td>
    <td><span class="tbadge ${i.severity}">${i.severity}</span></td>
    <td>${i.issue}</td>
  </tr>`).join('') || '<tr><td colspan="6" style="text-align:center;color:#15803d;padding:14px;">✓ No issues found</td></tr>';
}

function renderFieldStats(){
  const body=document.getElementById('fieldStatsBody');
  if(!body) return;
  body.innerHTML = NUMERIC_COLS.map(col=>{
    const vals=dqData.map(r=>parseFloat(r[col])).filter(v=>!isNaN(v));
    const nulls=dqData.length-vals.length;
    if(vals.length===0) return `<tr><td>${col}</td><td class="num" colspan="4">—</td><td class="num">${nulls}</td><td><span class="tbadge Error">No data</span></td></tr>`;
    const sorted=[...vals].sort((a,b)=>a-b);
    const min=sorted[0],max=sorted[sorted.length-1];
    const mean=vals.reduce((s,v)=>s+v,0)/vals.length;
    const median=sorted.length%2===0?(sorted[sorted.length/2-1]+sorted[sorted.length/2])/2:sorted[Math.floor(sorted.length/2)];
    const ok=nulls===0;
    return `<tr>
      <td>${col}</td>
      <td class="num">${min.toLocaleString('en-US',{maximumFractionDigits:2})}</td>
      <td class="num">${max.toLocaleString('en-US',{maximumFractionDigits:2})}</td>
      <td class="num">${mean.toLocaleString('en-US',{maximumFractionDigits:2})}</td>
      <td class="num">${median.toLocaleString('en-US',{maximumFractionDigits:2})}</td>
      <td class="num">${nulls}</td>
      <td><span class="tbadge ${ok?'Pass':'Warning'}">${ok?'Complete':nulls+' missing'}</span></td>
    </tr>`;
  }).join('');
}

function showCards(){
  ['dqKpiRow','dqChartsRow','dqTableCard','fieldStatsCard'].forEach(id=>{
    const el=document.getElementById(id);
    if(el) el.classList.remove('hidden');
  });
}

function showStatus(type,msg){
  const el=document.getElementById('uploadStatus');
  el.className='upload-status '+type;
  el.textContent=msg;
  el.classList.remove('hidden');
}
