/* ===== MDM export adapter =====
 * Converts the native MDM weekly report (e.g. JHP_MDM_Report_YYYYMMDD.csv) into the
 * dashboard's standard schema:
 *   source_id, source_name, source_records, golden_records, singleton_rate,
 *   potential_matches, week, status
 *
 * Native columns used:
 *   snapshot_date, period, client, resource_type, source,
 *   source_recs, golden_recs, singleton_pct, potential_matches
 *
 * Rows where source = "ALL" are per-resource-type totals. They are kept (flagged
 * is_rollup) so headline KPIs can use them instead of summing per-source rows,
 * which would double-count golden records shared across sources.
 */

const STANDARD_COLS = ['source_id','source_name','source_records','golden_records','singleton_rate','potential_matches','week','status','resource_type','singleton_records'];
const MDM_EXPORT_COLS = ['snapshot_date','resource_type','source','source_recs','golden_recs','singleton_pct'];
const JUMP_THRESHOLD_PCT = 5; // |week-over-week change in source records| above this => "Jump"

function isMDMExport(headers){
  return MDM_EXPORT_COLS.every(c => headers.includes(c)) && !headers.includes('source_records');
}

/* headers: lower-cased header names; records: array of {header: value} objects.
 * Returns {headers, rows} in the standard schema, or null if not the MDM export format. */
function convertMDMExport(headers, records){
  if(!isMDMExport(headers)) return null;

  const clients = new Set(records.map(r => r.client).filter(Boolean));
  const multiClient = clients.size > 1;

  const rows = records.map(r => {
    const isRollup = (r.source||'').toUpperCase() === 'ALL';
    const group = (multiClient ? r.client + '-' : '') + r.resource_type;
    const label = [r.client, r.resource_type].filter(Boolean).join(' ');
    return {
      _line: r._line,
      source_id: group + '-' + r.source,
      source_name: label + ' — ' + (isRollup ? 'All sources (total)' : r.source),
      source_records: r.source_recs,
      golden_records: r.golden_recs,
      singleton_rate: r.singleton_pct,
      // potential_matches is only reported on the ALL row; per-source rows are blank
      potential_matches: r.potential_matches === '' || r.potential_matches === undefined ? '0' : r.potential_matches,
      week: r.period ? `${r.snapshot_date} (${r.period})` : r.snapshot_date,
      status: r.status || '',
      resource_type: r.resource_type,
      // native export carries the raw count in `singletons`; fall back to deriving it from the percentage
      singleton_records: (r.singletons !== undefined && r.singletons !== '') ? r.singletons
        : String(Math.round((parseFloat(r.golden_recs)||0) * (parseFloat(r.singleton_pct)||0) / 100)),
      is_rollup: isRollup,
      group: group
    };
  });

  deriveStatus(rows);
  return { headers: STANDARD_COLS.concat(['is_rollup','group']), rows };
}

/* Fill empty status by comparing source records with the same source's previous week
 * in the file. The first week for a source has nothing to compare against and stays blank. */
function deriveStatus(rows){
  const bySource = {};
  rows.forEach(r => (bySource[r.source_id] = bySource[r.source_id] || []).push(r));
  Object.values(bySource).forEach(list => {
    list.sort((a,b) => a.week < b.week ? -1 : a.week > b.week ? 1 : 0);
    for(let i=1;i<list.length;i++){
      const cur = list[i];
      if(cur.status) continue;
      const prev = Number(list[i-1].source_records), now = Number(cur.source_records);
      if(isNaN(prev) || isNaN(now)) continue;
      if(now === prev) cur.status = 'No change';
      else if(prev > 0 && Math.abs(now-prev)/prev*100 > JUMP_THRESHOLD_PCT) cur.status = 'Jump';
      else cur.status = 'Updated';
    }
  });
}

/* Rows to use for totals: drop per-source rows whose resource type has an ALL (rollup) row. */
function totalsRows(rows){
  const rolled = new Set(rows.filter(r => r.is_rollup).map(r => r.group));
  return rows.filter(r => r.is_rollup || !rolled.has(r.group));
}

/* Rows to use for per-source breakdowns: everything except rollups. */
function sourceRows(rows){
  return rows.filter(r => !r.is_rollup);
}

/* ===== Header validation for the native MDM report =====
 * Every column below is required. Matching is case-insensitive and tolerant of spaces,
 * hyphens and a BOM, so "Source_Recs", "SOURCE RECS" and "source_recs" are all the same header.
 */
const MDM_REPORT_COLS = [
  'snapshot_date','period','client','resource_type','source','source_recs','golden_recs','singletons',
  'singleton_pct','shared_goldens','potential_matches','linked_source_recs','not_linked_recs',
  'single_record_goldens','single_record_pct','total_resource_records','sort_key'
];
/* Headers that only appear in the native report (used to recognise it) */
const MDM_NATIVE_SIGNATURE = ['snapshot_date','source_recs','golden_recs','singleton_pct','shared_goldens','linked_source_recs'];

function normalizeHeader(h){
  return String(h == null ? '' : h).replace(/^\uFEFF/, '').replace(/"/g, '').trim().toLowerCase().replace(/[\s\-]+/g, '_');
}

/* Returns null when the file is not the native MDM report (standard format is validated elsewhere).
 * Otherwise {errors:[...]} — empty when every required header is present exactly once. */
function checkMDMHeaders(headers){
  const standard = headers.includes('source_records');
  if(standard || !MDM_NATIVE_SIGNATURE.some(c => headers.includes(c))) return null;
  const errors = [];
  const missing = MDM_REPORT_COLS.filter(c => !headers.includes(c));
  missing.forEach(c => errors.push('Missing required column: "' + c + '"'));
  const seen = new Set(), dups = new Set();
  headers.forEach(h => { if(seen.has(h)) dups.add(h); seen.add(h); });
  dups.forEach(h => errors.push('Duplicate column: "' + h + '" appears more than once'));
  const extra = headers.filter(h => h && !MDM_REPORT_COLS.includes(h));
  if(errors.length){
    errors.push('Expected columns (any letter case): ' + MDM_REPORT_COLS.join(', '));
    if(extra.length) errors.push('Columns not recognised in this file: ' + [...new Set(extra)].join(', '));
  }
  return { errors, missing, extra };
}

/* Row-level checks for the native report columns the standard validation does not cover.
 * Returns {errors, badLines}; rows on badLines should be excluded. */
function validateMDMRecords(records){
  const errors = [], badLines = new Set();
  const numericOptional = ['shared_goldens','potential_matches','linked_source_recs','not_linked_recs','single_record_goldens','single_record_pct','total_resource_records','sort_key'];
  const validTypes = ['patient','practitioner','organization'];
  const bad = (r, msg) => { errors.push('Row ' + r._line + ': ' + msg); badLines.add(r._line); };
  records.forEach(r => {
    if(!String(r.snapshot_date || '').trim()) bad(r, 'snapshot_date is empty');
    else if(!/^\d{4}-\d{2}-\d{2}$/.test(String(r.snapshot_date).trim()) || isNaN(new Date(String(r.snapshot_date).trim() + 'T00:00:00').getTime())) bad(r, 'snapshot_date must be a date like 2026-10-19 (got "' + r.snapshot_date + '")');
    if(!String(r.source || '').trim()) bad(r, 'source is empty');
    if(!validTypes.includes(String(r.resource_type || '').trim().toLowerCase())) bad(r, 'resource_type must be Patient, Practitioner or Organization (got "' + (r.resource_type || '') + '")');
    const sing = String(r.singletons == null ? '' : r.singletons).trim();
    if(sing === '' || isNaN(Number(sing)) || Number(sing) < 0) bad(r, 'singletons must be a non-negative number (got "' + sing + '")');
    else if(r.golden_recs !== '' && !isNaN(Number(r.golden_recs)) && Number(sing) > Number(r.golden_recs)) bad(r, 'singletons (' + sing + ') cannot exceed golden_recs (' + r.golden_recs + ')');
    numericOptional.forEach(c => {
      const v = String(r[c] == null ? '' : r[c]).trim();
      if(v !== '' && isNaN(Number(v))) bad(r, c + ' must be a number when filled in (got "' + v + '")');
    });
    const sp = String(r.single_record_pct == null ? '' : r.single_record_pct).trim();
    if(sp !== '' && !isNaN(Number(sp)) && (Number(sp) < 0 || Number(sp) > 100)) bad(r, 'single_record_pct must be between 0 and 100 (got ' + sp + ')');
  });
  return { errors, badLines };
}
