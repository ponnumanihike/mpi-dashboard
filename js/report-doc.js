/* ===== Word report builder =====
 * Builds the Daily / Weekly / Monthly .doc reports from the uploaded data (allData).
 * Every figure and sentence is computed from the data; nothing is hard-coded.
 * Output is Word-compatible HTML (saved as .doc by downloadReport in main.js).
 */

const RD_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const RD_LONG_MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const RD_WATCH_PM_RATIO = 25;   // potential matches as % of golden records at/above which a resource is "Watch"
const RD_ATTENTION_PCT = 5;     // |change in source records| above this % => "Needs attention"
const RD_NAVY = '#1f3864';

const rdN = v => Number(v).toLocaleString('en-US');
const rdEsc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const rdPct = (v, d = 1) => v.toFixed(d) + '%';
const rdSign = d => d > 0 ? '+' : d < 0 ? '−' : '';

function rdJoinAnd(list){
  if(list.length <= 1) return list.join('');
  return list.slice(0,-1).join(', ') + ' and ' + list[list.length-1];
}

/* ---------- data context ---------- */
function rdContext(){
  const weeks = [...new Set(allData.map(r => r.week))].sort();
  const info = weeks.map((w,i) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:\s*\((.*)\))?$/.exec(w);
    const date = m ? new Date(+m[1], +m[2]-1, +m[3]) : null;
    return {
      key: w,
      date,
      short: date ? date.getDate() + ' ' + RD_MONTHS[date.getMonth()] : w,
      year: date ? date.getFullYear() : null,
      period: m && m[4] ? m[4] : (date ? 'Week ' + (i+1) : w)
    };
  });

  const known = ['Patient','Practitioner','Organization'];
  const present = [...new Set(allData.map(r => r.resource_type))];
  const types = known.filter(t => present.includes(t)).concat(present.filter(t => !known.includes(t)));

  const rowsFor = (t,w) => allData.filter(r => r.resource_type === t && r.week === w);
  const totals = (t,w) => {
    const rows = totalsRows(rowsFor(t,w));
    if(!rows.length) return null;
    const sum = k => rows.reduce((s,r) => s + (Number(r[k])||0), 0);
    const src = sum('source_records'), gold = sum('golden_records'), pm = sum('potential_matches'), sing = sum('singleton_records');
    return { src, gold, pm, sing,
      rate: gold > 0 ? sing/gold*100 : 0,
      pmRatio: gold > 0 ? pm/gold*100 : 0,
      hasRollup: rows.some(r => r.is_rollup) };
  };
  const sources = (t,w) => sourceRows(rowsFor(t,w)).map(r => ({
    label: String(r.source_name).includes(' — ') ? String(r.source_name).split(' — ').slice(1).join(' — ') : r.source_name,
    id: r.source_id, src: r.source_records, gold: r.golden_records, sing: r.singleton_records, status: r.status
  }));

  // Client name: "JHP Patient — Magellan" -> "JHP"
  let client = '';
  const sample = allData.find(r => String(r.source_name).includes(' — '));
  if(sample){
    client = String(sample.source_name).split(' — ')[0].replace(new RegExp('\\s*' + sample.resource_type + '$','i'),'').trim();
  }

  let fname = '';
  try { fname = sessionStorage.getItem('mdm_csv_name') || ''; } catch(e){}

  const ctx = { weeks, info, types, totals, sources, client, fname };
  ctx.series = t => weeks.map(w => totals(t,w));
  return ctx;
}

/* ---------- wording helpers ---------- */
function rdWeekRange(ctx){
  const a = ctx.info[0], b = ctx.info[ctx.info.length-1];
  if(ctx.info.length === 1) return a.period;
  const na = /^Week (\d+)$/.exec(a.period), nb = /^Week (\d+)$/.exec(b.period);
  return na && nb ? `Weeks ${na[1]} to ${nb[1]}` : `${a.period} to ${b.period}`;
}

function rdDateList(ctx, infos){
  const years = new Set(infos.map(i => i.year));
  if(years.size === 1 && infos[0].year){
    return rdJoinAnd(infos.map(i => i.short)) + ' ' + infos[0].year;
  }
  return rdJoinAnd(infos.map(i => i.short + (i.year ? ' ' + i.year : '')));
}

function rdDelta(cur, prev){
  if(prev === null || prev === undefined) return '—';
  const d = cur - prev;
  if(d === 0) return 'No change';
  return rdSign(d) + rdN(Math.abs(d)) + (prev > 0 ? ` (${rdSign(d)}${rdPct(Math.abs(d)/prev*100)})` : '');
}
function rdDeltaPts(cur, prev){
  if(prev === null || prev === undefined) return '—';
  const d = cur - prev;
  if(Math.abs(d) < 0.005) return 'No change';
  return rdSign(d) + Math.abs(d).toFixed(2) + ' pts';
}

/* "rose by 1,084 in Week 2 and 4,381 in Week 3" */
function rdMoves(vals, ctx){
  const parts = [];
  for(let i = 1; i < vals.length; i++){
    if(vals[i] === null || vals[i-1] === null) continue;
    const d = vals[i] - vals[i-1];
    parts.push({ d, wk: ctx.info[i].period });
  }
  if(!parts.length) return '';
  const out = [];
  let lastVerb = null;
  parts.forEach(p => {
    if(p.d === 0){ out.push('did not change in ' + p.wk); lastVerb = null; return; }
    const verb = p.d > 0 ? 'rose by' : 'fell by';
    out.push((verb !== lastVerb ? verb + ' ' : '') + rdN(Math.abs(p.d)) + ' in ' + p.wk);
    lastVerb = verb;
  });
  return rdJoinAnd(out);
}

/* Resource-level status for the latest snapshot vs a comparison snapshot. */
function rdStatus(cur, prev){
  if(!cur) return { label: '—', bg: '#f2f2f2' };
  if(prev){
    const pct = prev.src > 0 ? Math.abs(cur.src - prev.src)/prev.src*100 : 0;
    if(pct > RD_ATTENTION_PCT) return { label: 'Needs attention', bg: '#f8d7da' };
    if(cur.src === prev.src && cur.gold === prev.gold && cur.pm === prev.pm) return { label: 'Watch', bg: '#fff2cc' };
  }
  if(cur.pmRatio >= RD_WATCH_PM_RATIO) return { label: 'Watch', bg: '#fff2cc' };
  return { label: 'Stable', bg: '#e2f0d9' };
}

/* ---------- HTML building blocks ---------- */
function rdTable(headers, rows, opts = {}){
  const th = headers.map((h,i) => `<th style="background:${RD_NAVY};color:#fff;border:1px solid #8a8a8a;padding:5px 6px;font-size:9pt;text-align:${i===0?'left':'center'};">${rdEsc(h)}</th>`).join('');
  const body = rows.map(r => '<tr>' + r.map((c,i) => {
    const cell = (c && typeof c === 'object') ? c : { t: c };
    const align = cell.l || i === 0 ? 'left' : 'right';
    const bg = cell.bg || (opts.firstColShade && i === 0 ? '#f2f2f2' : '#fff');
    const bold = cell.b || (i === 0 && opts.boldFirst) ? 'font-weight:bold;' : '';
    const center = cell.c ? 'text-align:center;' : 'text-align:' + align + ';';
    return `<td style="border:1px solid #8a8a8a;padding:4px 6px;font-size:9pt;background:${bg};${bold}${center}">${rdEsc(cell.t)}</td>`;
  }).join('') + '</tr>').join('');
  return `<table border="1" cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%;margin:6px 0 4px;"><tr>${th}</tr>${body}</table>`;
}

const rdH2 = t => `<h2 style="font-size:14pt;color:${RD_NAVY};border-bottom:1px solid #bfbfbf;padding-bottom:2px;margin:20px 0 8px;">${rdEsc(t)}</h2>`;
const rdH3 = t => `<h3 style="font-size:11.5pt;color:#2e74b5;margin:14px 0 4px;">${rdEsc(t)}</h3>`;
const rdH4 = t => `<p style="font-weight:bold;margin:12px 0 2px;">${rdEsc(t)}</p>`;
const rdP = t => `<p style="margin:6px 0;">${t}</p>`;
const rdNote = t => `<p style="font-style:italic;font-size:8.5pt;color:#444;margin:2px 0 8px;">${t}</p>`;

function rdNumbered(items){
  return '<ol style="margin:6px 0 6px 18px;padding:0;">' + items.map(i => `<li style="margin:5px 0;">${i}</li>`).join('') + '</ol>';
}
function rdBullets(items){
  return '<ul style="margin:6px 0 6px 18px;padding:0;">' + items.map(i => `<li style="margin:5px 0;">${i}</li>`).join('') + '</ul>';
}

/* ---------- shared sections ---------- */
const RD_STATUS_KEY = 'Status key: Stable means small, expected movement. No change means identical figures to the comparison snapshot. Watch means a figure is high or a feed needs confirming. Needs attention means a figure is moving quickly.';

function rdStandsTable(ctx, compareIdx, compareLabel){
  const last = ctx.weeks.length - 1;
  const rows = ctx.types.map(t => {
    const cur = ctx.totals(t, ctx.weeks[last]);
    const prev = compareIdx >= 0 ? ctx.totals(t, ctx.weeks[compareIdx]) : null;
    const st = rdStatus(cur, prev);
    if(!cur) return [t,'—','—','—','—','—','—'];
    return [
      { t, b: true, bg: '#f2f2f2' },
      rdN(cur.src),
      { t: rdDelta(cur.src, prev && prev.src), c: true },
      rdN(cur.gold),
      rdN(cur.pm),
      { t: rdDelta(cur.pm, prev && prev.pm), c: true },
      { t: st.label, bg: st.bg, c: true }
    ];
  });
  return rdTable(['Resource','Source records','Change ' + compareLabel,'Golden records','Potential matches','Change ' + compareLabel,'Status'], rows)
    + rdNote(RD_STATUS_KEY);
}

/* Which sources (by label) never changed in any snapshot, in every resource they appear in. */
function rdFrozenSources(ctx){
  if(ctx.weeks.length < 2) return [];
  const byLabel = {};
  ctx.types.forEach(t => {
    const seen = {};
    ctx.weeks.forEach(w => ctx.sources(t,w).forEach(s => { (seen[s.label] = seen[s.label] || []).push(Number(s.src)); }));
    Object.keys(seen).forEach(l => {
      const v = seen[l];
      const frozen = v.length >= 2 && v.every(x => x === v[0]);
      (byLabel[l] = byLabel[l] || []).push(frozen);
    });
  });
  return Object.keys(byLabel).filter(l => byLabel[l].every(Boolean));
}

/* Resources whose headline figures were identical across the trailing snapshots. */
function rdUnchangedResources(ctx){
  const out = [];
  if(ctx.weeks.length < 2) return out;
  ctx.types.forEach(t => {
    const s = ctx.series(t);
    let run = 0;
    for(let i = s.length-1; i > 0; i--){
      if(s[i] && s[i-1] && s[i].src === s[i-1].src && s[i].gold === s[i-1].gold && s[i].pm === s[i-1].pm) run++; else break;
    }
    if(run > 0) out.push({ type: t, weeks: ctx.info.slice(s.length-1-run).map(i => i.period) });
  });
  return out;
}

function rdSharedGolden(ctx, t, w){
  const tot = ctx.totals(t,w);
  const srcs = ctx.sources(t,w);
  if(!tot || srcs.length < 2) return null;
  const sumGold = srcs.reduce((s,x) => s + (Number(x.gold)||0), 0);
  if(sumGold <= tot.gold) return null;
  return { sumGold, allGold: tot.gold, shared: sumGold - tot.gold };
}

function rdWatchItems(ctx, compareIdx){
  const items = [];
  const last = ctx.weeks.length - 1;
  const latest = ctx.weeks[last];
  const lw = ctx.info[last].period;

  // 1. Largest potential-match queue relative to size
  const ranked = ctx.types.map(t => ({ t, c: ctx.totals(t, latest) })).filter(x => x.c && x.c.gold > 0)
    .sort((a,b) => b.c.pmRatio - a.c.pmRatio);
  if(ranked.length){
    const top = ranked[0], others = ranked.slice(1);
    let txt = `<b>${rdEsc(top.t)} potential matches (${rdN(top.c.pm)}).</b> ${rdN(top.c.pm)} pairs against ${rdN(top.c.gold)} golden records (${rdPct(top.c.pmRatio)}).`;
    if(others.length){
      txt += ' ' + rdJoinAnd(others.map(o => `${rdEsc(o.t)} has ${rdN(o.c.pm)} against ${rdN(o.c.gold)} (${rdPct(o.c.pmRatio)})`)) + '.';
    }
    if(top.c.pm > 0) txt += ' Review which matching rules are creating the largest share of pairs.';
    items.push(txt);
  }

  // 2. Feeds that did not change
  const unchanged = rdUnchangedResources(ctx);
  const frozen = rdFrozenSources(ctx);
  if(unchanged.length || frozen.length){
    const bits = [];
    unchanged.forEach(u => bits.push(`${rdEsc(u.type)} figures are identical in ${rdJoinAnd(u.weeks)}`));
    if(frozen.length) bits.push(`${rdJoinAnd(frozen.map(rdEsc))} ${frozen.length === 1 ? 'is' : 'are'} unchanged in every snapshot`);
    items.push(`<b>Feeds that did not change.</b> ${bits.join('; ')}. Confirm whether new data was sent or whether the match link extract and totals file were not refreshed.`);
  }

  // 3. Jumps
  if(compareIdx >= 0){
    const jumps = [];
    ctx.types.forEach(t => {
      const cur = ctx.totals(t, latest), prev = ctx.totals(t, ctx.weeks[compareIdx]);
      if(cur && prev && prev.src > 0 && Math.abs(cur.src-prev.src)/prev.src*100 > RD_ATTENTION_PCT){
        jumps.push(`${rdEsc(t)} source records moved ${rdDelta(cur.src, prev.src)}`);
      }
    });
    if(jumps.length) items.push(`<b>Large movement.</b> ${jumps.join('; ')}. Confirm this is expected.`);
  }

  // 4. Shared golden records / dashboard totals
  const shared = ctx.types.map(t => ({ t, s: rdSharedGolden(ctx, t, latest) })).filter(x => x.s);
  if(shared.length){
    items.push(`<b>Totals across sources.</b> ${rdJoinAnd(shared.map(x => `${rdEsc(x.t)} per-source golden counts add up to ${rdN(x.s.sumGold)}, against ${rdN(x.s.allGold)} on the all-sources row`))} in ${rdEsc(lw)}. Golden records shared by more than one source are counted once in this report. See the notes below.`);
  }

  if(!items.length) items.push('Nothing needs attention in the uploaded data.');
  return items;
}

function rdNotes(ctx){
  const last = ctx.weeks.length - 1;
  const latest = ctx.weeks[last];
  const lw = ctx.info[last].period;
  const items = [
    `All figures come from ${ctx.fname ? 'the uploaded file <b>' + rdEsc(ctx.fname) + '</b>' : 'the uploaded CSV file'}. Totals, potential matches and ratios use the all-sources row (ALL) where the file has one, so each golden record is counted once.`,
    'Source records are the records loaded in the source system. Golden records are the distinct golden records linked to that source.',
    '<b>A singleton is a golden record whose linked records all come from one source system.</b> Singleton rate is singleton records divided by golden records.',
    'Potential matches are reported for all sources together. A blank or zero figure on a per-source row means the file carried no count at that level.',
    'Status is worked out from the data: a change in source records above ' + RD_ATTENTION_PCT + '% is Needs attention; identical figures to the comparison snapshot, or potential matches at ' + RD_WATCH_PM_RATIO + '% or more of golden records, is Watch; otherwise Stable.'
  ];
  ctx.types.forEach(t => {
    const s = rdSharedGolden(ctx, t, latest);
    if(s){
      items.push(`<b>Per-source totals (${rdEsc(t)}, ${rdEsc(lw)}).</b> Adding the per-source golden counts gives ${rdN(s.sumGold)}. The all-sources golden count is ${rdN(s.allGold)}. The difference of ${rdN(s.shared)} is golden records shared by more than one source, which the per-source rows count once for each source. Use the all-sources figure for totals.`);
    }
  });
  return rdBullets(items);
}

/* Per-resource week-by-week measure table + commentary (weekly & monthly). */
function rdProgressBlock(ctx, t){
  const s = ctx.series(t);
  const last = s.length - 1;
  const cur = s[last], prev = last > 0 ? s[last-1] : null;
  const heads = ['Measure'].concat(ctx.info.map(i => `${i.period} (${i.short})`), [`Change in ${ctx.info[last].period}`]);
  const val = (fn) => s.map(x => x ? fn(x) : '—');
  const rows = [
    ['Source records'].concat(val(x => rdN(x.src)), [{ t: rdDelta(cur.src, prev && prev.src), c: true }]),
    ['Golden records'].concat(val(x => rdN(x.gold)), [{ t: rdDelta(cur.gold, prev && prev.gold), c: true }]),
    ['Singleton rate (golden records from a single source system)'].concat(val(x => x.rate.toFixed(2) + '%'), [{ t: rdDeltaPts(cur.rate, prev && prev.rate), c: true }]),
    ['Potential matches'].concat(val(x => rdN(x.pm)), [{ t: rdDelta(cur.pm, prev && prev.pm), c: true }])
  ];
  let html = rdTable(heads, rows);

  const srcMoves = rdMoves(s.map(x => x && x.src), ctx);
  const goldMoves = rdMoves(s.map(x => x && x.gold), ctx);
  const pmMoves = rdMoves(s.map(x => x && x.pm), ctx);
  const sentences = [];
  if(srcMoves) sentences.push(`Source records ${srcMoves}.`);
  if(goldMoves) sentences.push(`Golden records ${goldMoves}.`);
  if(pmMoves) sentences.push(`Potential matches ${pmMoves}.`);
  if(sentences.length) html += rdP(sentences.join(' '));
  html += rdP(`${rdPct(cur.rate, 1)} of ${rdEsc(t)} golden records come from a single source system.`);
  return html;
}

function rdBySourceTable(ctx, t, w){
  const srcs = ctx.sources(t, w).sort((a,b) => b.src - a.src);
  if(!srcs.length) return '';
  const showShared = !!rdSharedGolden(ctx, t, w);
  const rows = srcs.map(s => {
    const gold = Number(s.gold) || 0, sing = Number(s.sing) || 0;
    const row = [
      { t: s.label, b: true },
      rdN(s.src), rdN(s.gold),
      gold > 0 ? `${rdN(sing)} (${rdPct(sing/gold*100)})` : rdN(sing)
    ];
    if(showShared) row.push(gold > 0 ? `${rdN(gold - sing)} (${rdPct((gold - sing)/gold*100)})` : '—');
    return row;
  });
  const heads = ['Source','Source records','Golden records','Singletons (single source system)'];
  if(showShared) heads.push('Also in another source');
  return rdH4(`${t} by source in ${ctx.info[ctx.weeks.indexOf(w)].period}`)
    + rdTable(heads, rows);
}

/* Up to this many sources, every source's share is written out in the sentence.
 * Above it, the sentence summarises and the by-source table carries each figure. */
const RD_SHARING_INLINE_MAX = 6;
const RD_SHARING_TOP = 5;

function rdSharingParagraph(ctx, t){
  const w = ctx.weeks[ctx.weeks.length-1];
  const shared = rdSharedGolden(ctx, t, w);
  const srcs = ctx.sources(t, w).filter(s => Number(s.gold) > 0)
    .map(s => ({ label: s.label, pct: (Number(s.gold) - Number(s.sing)) / Number(s.gold) * 100 }));
  if(!shared || srcs.length < 2) return '';
  const lead = `Matching across sources is happening: ${rdN(shared.shared)} golden records are shared by more than one source.`;

  if(srcs.length <= RD_SHARING_INLINE_MAX){
    const parts = srcs.map(s => `${rdPct(s.pct)} of ${rdEsc(s.label)}'s`);
    return rdP(`${lead} Records that also exist in another source make up ${rdJoinAnd(parts)} golden records.`);
  }

  const sorted = [...srcs].sort((a, b) => b.pct - a.pct);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid].pct : (sorted[mid-1].pct + sorted[mid].pct) / 2;
  const all = sorted.filter(s => s.pct >= 99.95).length;     // shows as 100.0%
  const none = sorted.filter(s => s.pct < 0.05).length;      // shows as 0.0%
  const top = sorted.filter(s => s.pct < 99.95 && s.pct >= 0.05).slice(0, RD_SHARING_TOP)
    .map(s => `${rdEsc(s.label)} (${rdPct(s.pct)})`);

  const sentences = [lead,
    `Across the ${rdN(sorted.length)} sources, the median share of a source's golden records that also exist in another source is ${rdPct(median)}.`];
  if(all) sentences.push(`${rdN(all)} ${all === 1 ? 'source has' : 'sources have'} all of ${all === 1 ? 'its' : 'their'} golden records in another source (100.0%).`);
  if(top.length) sentences.push(`${all ? 'Below that, the' : 'The'} highest ${top.length === 1 ? 'is' : 'are'} ${rdJoinAnd(top)}.`);
  if(none) sentences.push(`${rdN(none)} ${none === 1 ? 'source shows' : 'sources show'} 0.0%.`);
  sentences.push(`The "Also in another source" column in the table below gives the figure for every source.`);
  return rdP(sentences.join(' '));
}

/* ---------- short version ---------- */
function rdShortVersion(ctx, mode){
  const last = ctx.weeks.length - 1;
  const latest = ctx.weeks[last];
  const paras = [];

  if(ctx.weeks.length === 1){
    paras.push(rdP('Only one snapshot is loaded, so no change over time can be shown yet. Figures below are for ' + rdEsc(ctx.info[0].period) + '.'));
  }

  // Resource with the most source records leads
  const leader = ctx.types.map(t => ({ t, s: ctx.series(t) })).filter(x => x.s[last])
    .sort((a,b) => b.s[last].src - a.s[last].src)[0];
  if(leader){
    const s = leader.s;
    const cur = s[last];
    const moves = rdMoves(s.map(x => x && x.src), ctx);
    let line = `${rdEsc(leader.t)} has ${rdN(cur.src)} source records and ${rdN(cur.gold)} golden records.`;
    if(moves) line = `${rdEsc(leader.t)} source records ${moves}` + rdTopContributor(ctx, leader.t) + `, now ${rdN(cur.src)}.`;
    let pmLine = '';
    if(last > 0 && s[last-1]){
      const d = cur.pm - s[last-1].pm;
      const rel = s[last-1].pm > 0 ? Math.abs(d)/s[last-1].pm : 0;
      pmLine = ` ${rdEsc(leader.t)} potential matches are ${rdN(cur.pm)}` +
        (d === 0 ? ', unchanged' : `, ${d > 0 ? 'up' : 'down'}${rel < 0.01 ? ' only' : ''} ${rdN(Math.abs(d))} in ${ctx.info[last].period}`) + '.';
    } else {
      pmLine = ` ${rdEsc(leader.t)} has ${rdN(cur.pm)} potential matches.`;
    }
    paras.push(rdP(line + pmLine));
  }

  // Queue size comparison
  const ranked = ctx.types.map(t => ({ t, c: ctx.totals(t, latest) })).filter(x => x.c && x.c.gold > 0)
    .sort((a,b) => b.c.pmRatio - a.c.pmRatio);
  const sentences = [];
  if(ranked.length > 1 && ranked[0].c.pm > 0){
    const hi = ranked[0], lo = ranked[ranked.length-1];
    sentences.push(`${rdEsc(hi.t)} has ${rdN(hi.c.pm)} potential matches against ${rdN(hi.c.gold)} golden records (${rdPct(hi.c.pmRatio)})${hi.c.pmRatio >= 2*lo.c.pmRatio ? `, a much larger queue relative to its size than ${rdEsc(lo.t)} (${rdPct(lo.c.pmRatio)})` : ''}.`);
  }
  const unchanged = rdUnchangedResources(ctx);
  if(unchanged.length){
    const names = rdJoinAnd(unchanged.map(u => rdEsc(u.type)));
    const wks = unchanged[0].weeks;
    sentences.push(`${names} figures were identical in ${rdJoinAnd(wks)}.`);
  }
  const frozen = rdFrozenSources(ctx);
  if(frozen.length){
    sentences.push(`The ${rdJoinAnd(frozen.map(rdEsc))} ${frozen.length === 1 ? 'source' : 'sources'} did not change in any snapshot, so it is worth confirming that ${frozen.length === 1 ? 'that feed is' : 'those feeds are'} refreshing.`);
  }
  if(sentences.length) paras.push(rdP(sentences.join(' ')));
  return paras.join('');
}

/* ", all of it from the JHP source" — which source drove the change in source records */
function rdTopContributor(ctx, t){
  if(ctx.weeks.length < 2) return '';
  const first = ctx.sources(t, ctx.weeks[0]), last = ctx.sources(t, ctx.weeks[ctx.weeks.length-1]);
  const deltas = {};
  last.forEach(s => { deltas[s.label] = (deltas[s.label]||0) + Number(s.src); });
  first.forEach(s => { deltas[s.label] = (deltas[s.label]||0) - Number(s.src); });
  const labels = Object.keys(deltas).filter(l => deltas[l] !== 0);
  const total = labels.reduce((s,l) => s + Math.abs(deltas[l]), 0);
  if(!labels.length || total === 0) return '';
  const top = labels.sort((a,b) => Math.abs(deltas[b]) - Math.abs(deltas[a]))[0];
  const share = Math.abs(deltas[top]) / total;
  if(labels.length === 1) return `, all of it from the ${rdEsc(top)} source`;
  if(share >= 0.9) return `, almost all of it from the ${rdEsc(top)} source`;
  return '';
}

/* ---------- document shell ---------- */
function rdWrap(title, headerLine, bodyHtml){
  return '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">'
    + '<head><meta charset="utf-8"><title>' + rdEsc(title) + '</title>'
    + '<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom></w:WordDocument></xml><![endif]-->'
    + '<style>@page{size:8.5in 11in;margin:0.8in;} body{font-family:Arial,Helvetica,sans-serif;font-size:10.5pt;color:#222;line-height:1.35;} p{margin:6px 0;} li{font-size:10.5pt;}</style>'
    + '</head><body>'
    + `<p style="text-align:right;color:#8a8a8a;font-size:8.5pt;margin:0 0 14px;">${rdEsc(headerLine)}</p>`
    + bodyHtml + '</body></html>';
}

function rdTitleBlock(title, sub, ctx){
  const prepared = new Date();
  const preparedTxt = prepared.getDate() + ' ' + RD_LONG_MONTHS[prepared.getMonth()] + ' ' + prepared.getFullYear();
  return `<h1 style="font-size:22pt;color:${RD_NAVY};margin:0 0 2px;">${rdEsc(title)}</h1>`
    + `<p style="font-size:12pt;color:#444;margin:0 0 6px;">${rdEsc(sub)}</p>`
    + `<hr style="border:0;border-top:1px solid #444;margin:4px 0 8px;">`
    + `<p style="font-style:italic;font-size:9pt;color:#444;">Prepared on ${preparedTxt} from ${ctx.fname ? rdEsc(ctx.fname) : 'the uploaded CSV file'}. ${rdJoinAnd(ctx.types.map(rdEsc))} ${ctx.types.length === 1 ? 'is' : 'are'} covered.</p>`;
}

/* ---------- the three reports ---------- */
function rdWeekly(ctx){
  const last = ctx.weeks.length - 1;
  const lw = ctx.info[last].period;
  const title = `${ctx.client ? ctx.client + ' ' : ''}MPI Weekly Monitoring Summary`;
  const sub = `${rdWeekRange(ctx)}: snapshots of ${rdDateList(ctx, ctx.info)}`;
  let n = 0;
  const sec = t => rdH2(`${++n}. ${t}`);
  let html = rdTitleBlock(title, sub, ctx);
  html += sec('The short version') + rdShortVersion(ctx, 'weekly');
  html += sec('Where each resource stands this week')
    + rdP(`Latest snapshot (${rdEsc(lw)}) with the change since ${last > 0 ? rdEsc(ctx.info[last-1].period) : 'the previous snapshot'}.`)
    + rdStandsTable(ctx, last - 1, 'vs last week');
  html += sec('Week-over-week progress');
  ctx.types.forEach((t,i) => {
    html += rdH3(`${n}.${i+1} ${t}`) + rdProgressBlock(ctx, t) + rdSharingParagraph(ctx, t) + rdBySourceTable(ctx, t, ctx.weeks[last]);
  });
  html += sec('What to watch and confirm') + rdNumbered(rdWatchItems(ctx, last - 1));
  html += sec('Notes on the numbers') + rdNotes(ctx);
  return rdWrap(title, `${title}  |  ${rdWeekRange(ctx)}`, html);
}

function rdDaily(ctx){
  const last = ctx.weeks.length - 1;
  const lw = ctx.info[last], pw = last > 0 ? ctx.info[last-1] : null;
  const title = `${ctx.client ? ctx.client + ' ' : ''}MPI Daily Source Activity Summary`;
  const sub = `Latest snapshot: ${lw.short}${lw.year ? ' ' + lw.year : ''} (${lw.period})` + (pw ? `, compared with ${pw.short}${pw.year ? ' ' + pw.year : ''} (${pw.period})` : '');
  let n = 0;
  const sec = t => rdH2(`${++n}. ${t}`);
  let html = rdTitleBlock(title, sub, ctx);

  // Feed status counts across all per-source rows in the latest snapshot
  const counts = { Updated: 0, Jump: 0, 'No change': 0, Other: 0 };
  ctx.types.forEach(t => ctx.sources(t, ctx.weeks[last]).forEach(s => {
    const k = ['Updated','Jump','No change'].includes(s.status) ? s.status : 'Other';
    counts[k]++;
  }));
  const countTxt = rdJoinAnd(['Updated','Jump','No change'].filter(k => counts[k] > 0).map(k => `${counts[k]} ${k}`));
  html += sec('The short version') + rdShortVersion(ctx, 'daily')
    + (countTxt ? rdP(`Feed status across all sources in ${rdEsc(lw.period)}: ${countTxt}.`) : '');
  html += sec('Where each resource stands')
    + rdP(`Latest snapshot (${rdEsc(lw.period)}) with the change since ${pw ? rdEsc(pw.period) : 'the previous snapshot'}.`)
    + rdStandsTable(ctx, last - 1, 'vs previous');

  html += sec('Source activity');
  ctx.types.forEach((t,i) => {
    const cur = ctx.sources(t, ctx.weeks[last]).sort((a,b) => b.src - a.src);
    const prevMap = {};
    if(last > 0) ctx.sources(t, ctx.weeks[last-1]).forEach(s => { prevMap[s.label] = s; });
    const rows = cur.map(s => {
      const p = prevMap[s.label];
      return [
        { t: s.label, b: true },
        rdN(s.src),
        { t: rdDelta(Number(s.src), p ? Number(p.src) : null), c: true },
        rdN(s.gold),
        { t: rdDelta(Number(s.gold), p ? Number(p.gold) : null), c: true },
        { t: s.status || '—', c: true, bg: s.status === 'Jump' ? '#f8d7da' : s.status === 'No change' ? '#fff2cc' : '#fff' }
      ];
    });
    const tot = ctx.totals(t, ctx.weeks[last]);
    html += rdH3(`${n}.${i+1} ${t}`)
      + (rows.length ? rdTable(['Source','Source records','Change vs previous','Golden records','Change vs previous','Feed status'], rows) : rdP('No per-source rows in this snapshot.'))
      + (tot ? rdP(`All sources: ${rdN(tot.src)} source records, ${rdN(tot.gold)} golden records and ${rdN(tot.pm)} potential matches.`) : '');
  });
  html += sec('What to watch and confirm') + rdNumbered(rdWatchItems(ctx, last - 1));
  html += sec('Notes on the numbers') + rdBullets([
    'The uploaded file holds weekly snapshots, so this summary compares the latest snapshot with the one before it.',
    'Feed status is taken from the file, or worked out as: identical source records = No change; a change above ' + RD_ATTENTION_PCT + '% = Jump; any other change = Updated. The first snapshot for a source has no status.'
  ]) + rdNotes(ctx);
  return rdWrap(title, `${title}  |  ${lw.period}`, html);
}

function rdDataQuality(){
  const valid = ['updated','jump','no change',''];
  const types = ['patient','practitioner','organization'];
  let errors = 0, warnings = 0;
  const kinds = {};
  const add = (sev, kind) => { if(sev === 'E') errors++; else warnings++; kinds[kind] = (kinds[kind]||0) + 1; };
  const seen = {};
  allData.forEach(r => {
    if(r.singleton_rate < 0 || r.singleton_rate > 100) add('E','Singleton rate outside 0–100');
    if(r.singleton_records > r.golden_records) add('E','Singleton records exceed golden records');
    if(r.source_records > 0 && r.golden_records > r.source_records) add('E','Golden records exceed source records');
    if(!valid.includes(String(r.status||'').toLowerCase())) add('W','Unrecognised status value');
    if(!types.includes(String(r.resource_type||'').toLowerCase())) add('W','Invalid resource type');
    const k = r.source_id + '||' + r.week;
    if(seen[k]) add('W','Duplicate source and week'); else seen[k] = true;
  });
  return { errors, warnings, kinds };
}

function rdMonthly(ctx){
  const last = ctx.weeks.length - 1;
  const title = `${ctx.client ? ctx.client + ' ' : ''}MPI Executive and Compliance Summary`;
  const sub = `${rdWeekRange(ctx)}: snapshots of ${rdDateList(ctx, ctx.info)}`;
  let n = 0;
  const sec = t => rdH2(`${++n}. ${t}`);
  let html = rdTitleBlock(title, sub, ctx);

  html += sec('The short version') + rdShortVersion(ctx, 'monthly');
  html += sec('Where each resource stands')
    + rdP(`Latest snapshot (${rdEsc(ctx.info[last].period)}) with the change since the first snapshot (${rdEsc(ctx.info[0].period)}).`)
    + rdStandsTable(ctx, last > 0 ? 0 : -1, 'over period');

  // Period KPI comparison (first vs latest) + calendar-month comparison when the data spans months
  html += sec('Period comparison');
  const kpiRows = [];
  ctx.types.forEach(t => {
    const a = ctx.totals(t, ctx.weeks[0]), b = ctx.totals(t, ctx.weeks[last]);
    if(!a || !b) return;
    kpiRows.push([{ t, b: true, bg: '#f2f2f2' },
      `${rdN(a.src)} → ${rdN(b.src)}`, `${rdN(a.gold)} → ${rdN(b.gold)}`,
      `${a.rate.toFixed(2)}% → ${b.rate.toFixed(2)}%`, `${rdN(a.pm)} → ${rdN(b.pm)}`,
      `${a.pmRatio.toFixed(2)}% → ${b.pmRatio.toFixed(2)}%`]);
  });
  html += rdP(`First snapshot (${rdEsc(ctx.info[0].period)}) compared with the latest (${rdEsc(ctx.info[last].period)}).`)
    + rdTable(['Resource','Source records','Golden records','Singleton rate','Potential matches','Potential matches / golden'], kpiRows);

  const monthKeys = [...new Set(ctx.info.map(i => i.date ? i.date.getFullYear() + '-' + String(i.date.getMonth()+1).padStart(2,'0') : null).filter(Boolean))];
  if(monthKeys.length >= 2){
    const lastOfMonth = monthKeys.map(mk => {
      const idxs = ctx.info.map((i,ix) => i.date && (i.date.getFullYear() + '-' + String(i.date.getMonth()+1).padStart(2,'0')) === mk ? ix : -1).filter(x => x >= 0);
      return idxs[idxs.length-1];
    });
    const heads = ['Resource / measure'].concat(lastOfMonth.map(ix => { const d = ctx.info[ix].date; return `${RD_MONTHS[d.getMonth()]} ${d.getFullYear()} (${ctx.info[ix].short})`; }));
    const mrows = [];
    ctx.types.forEach(t => {
      const vals = lastOfMonth.map(ix => ctx.totals(t, ctx.weeks[ix]));
      mrows.push([{ t: `${t}: source records`, b: true }].concat(vals.map(v => v ? rdN(v.src) : '—')));
      mrows.push([`${t}: golden records`].concat(vals.map(v => v ? rdN(v.gold) : '—')));
      mrows.push([`${t}: potential matches`].concat(vals.map(v => v ? rdN(v.pm) : '—')));
    });
    html += rdP('Month-on-month: the last snapshot in each calendar month.') + rdTable(heads, mrows);
  } else {
    html += rdNote('All snapshots fall in one calendar month, so the comparison above is first against latest snapshot.');
  }

  // Trends
  html += sec('Trends across the period');
  ctx.types.forEach((t,i) => {
    const s = ctx.series(t);
    const heads = ['Measure'].concat(ctx.info.map(x => `${x.period} (${x.short})`));
    const rows = [
      ['Source records'].concat(s.map(x => x ? rdN(x.src) : '—')),
      ['Golden records'].concat(s.map(x => x ? rdN(x.gold) : '—')),
      ['Singleton rate'].concat(s.map(x => x ? x.rate.toFixed(2) + '%' : '—')),
      ['Potential matches'].concat(s.map(x => x ? rdN(x.pm) : '—')),
      ['Potential matches / golden'].concat(s.map(x => x ? x.pmRatio.toFixed(2) + '%' : '—'))
    ];
    html += rdH3(`${n}.${i+1} ${t}`) + rdTable(heads, rows);
  });

  // Source-level breakdown for all sources
  html += sec('Source-level breakdown');
  html += rdP(`All sources in the latest snapshot (${rdEsc(ctx.info[last].period)}).`);
  ctx.types.forEach(t => { html += rdBySourceTable(ctx, t, ctx.weeks[last]); });

  // Data quality
  const dq = rdDataQuality();
  html += sec('Data quality summary')
    + rdTable(['Severity','Count'], [[{ t: 'Errors', b: true }, rdN(dq.errors)], [{ t: 'Warnings', b: true }, rdN(dq.warnings)]])
    + (Object.keys(dq.kinds).length
        ? rdP('Issues found: ' + Object.keys(dq.kinds).map(k => `${rdEsc(k)} (${rdN(dq.kinds[k])})`).join('; ') + '.')
        : rdP('No data quality issues were found in the loaded rows.'))
    + rdNote('Counts cover the checks that can be run on the loaded data: singleton rate range, singleton and golden record limits, status values, resource type and duplicate source and snapshot. Row-level format errors are shown on the Data Quality page.');

  html += sec('What to watch and confirm') + rdNumbered(rdWatchItems(ctx, last > 0 ? last - 1 : -1));
  html += sec('Notes on the numbers') + rdNotes(ctx);
  return rdWrap(title, `${title}  |  ${rdWeekRange(ctx)}`, html);
}

/* ---------- week-over-week comparison ---------- */

/* Every headline field, as a function of a totals object (see rdContext().totals). */
const RD_FIELDS = [
  { name: 'Source records',            get: t => t.src,                          kind: 'int' },
  { name: 'Golden records',            get: t => t.gold,                         kind: 'int' },
  { name: 'Source : golden ratio',     get: t => t.gold > 0 ? t.src / t.gold : 0, kind: 'ratio' },
  { name: 'Singleton records',         get: t => t.sing,                         kind: 'int' },
  { name: 'Singleton rate',            get: t => t.rate,                         kind: 'pct' },
  { name: 'Potential matches',         get: t => t.pm,                           kind: 'int' },
  { name: 'Potential matches / golden', get: t => t.pmRatio,                     kind: 'pct' }
];

function rdFmtKind(v, kind){
  if(kind === 'int') return rdN(v);
  if(kind === 'ratio') return v.toFixed(3);
  return v.toFixed(2) + '%';
}

/* {diffTxt, pctTxt, dir} for a previous -> current change of one field */
function rdVariation(cur, prev, kind){
  const d = cur - prev;
  const shown = kind === 'int' ? rdN(Math.abs(d)) : kind === 'ratio' ? Math.abs(d).toFixed(3) : Math.abs(d).toFixed(2) + ' pts';
  const zero = Math.abs(d) < 1e-9 || shown.replace(/[^0-9]/g,'').replace(/0/g,'') === '';
  if(zero) return { diffTxt: '0', pctTxt: '0.0%', dir: 'No change' };
  return {
    diffTxt: rdSign(d) + shown,
    pctTxt: kind !== 'pct' && prev > 0 ? rdSign(d) + rdPct(Math.abs(d) / prev * 100) : '—',
    dir: d > 0 ? 'Increase' : 'Decrease'
  };
}

const RD_DIR_BG = { 'Increase': '#ddebf7', 'Decrease': '#fce4d6', 'No change': '#f2f2f2' };

/* The two weeks being compared: the latest and the one before it. */
function rdComparePair(ctx){
  if(ctx.weeks.length < 2) return null;
  const ci = ctx.weeks.length - 1, pi = ci - 1;
  return { ci, pi, cur: ctx.info[ci], prev: ctx.info[pi], curKey: ctx.weeks[ci], prevKey: ctx.weeks[pi] };
}

function rdWeekText(i){ return `${i.period} (${i.short}${i.year ? ' ' + i.year : ''})`; }

/* Source-level comparison rows for one resource type: current vs previous week, by source label. */
function rdSourceCompare(ctx, t, pair){
  const cur = ctx.sources(t, pair.curKey), prev = ctx.sources(t, pair.prevKey);
  const labels = [...new Set(cur.map(s => s.label).concat(prev.map(s => s.label)))];
  return labels.map(l => ({
    label: l,
    cur: cur.find(s => s.label === l) || null,
    prev: prev.find(s => s.label === l) || null
  })).sort((a,b) => ((b.cur && b.cur.src) || 0) - ((a.cur && a.cur.src) || 0));
}
const rdSingPct = s => s && s.gold > 0 ? s.sing / s.gold * 100 : 0;

function rdComparison(ctx){
  const pair = rdComparePair(ctx);
  const last = ctx.weeks.length - 1;
  const title = `${ctx.client ? ctx.client + ' ' : ''}MPI Week-over-Week Comparison Summary`;
  const sub = `${rdWeekText(pair.cur)} compared with ${rdWeekText(pair.prev)}`;
  let n = 0;
  const sec = t => rdH2(`${++n}. ${t}`);
  let html = rdTitleBlock(title, sub, ctx);

  // 1. Short version
  html += sec('The short version');
  const lines = [];
  ctx.types.forEach(t => {
    const c = ctx.totals(t, pair.curKey), p = ctx.totals(t, pair.prevKey);
    if(!c || !p){ lines.push(`${rdEsc(t)} has data in only one of the two weeks, so it cannot be compared.`); return; }
    const changed = [], same = [];
    RD_FIELDS.forEach(f => {
      const v = rdVariation(f.get(c), f.get(p), f.kind);
      if(v.dir === 'No change') same.push(f.name.toLowerCase());
      else changed.push(`${f.name.toLowerCase()} ${v.dir === 'Increase' ? 'rose' : 'fell'} by ${v.diffTxt.replace(/^[+−]/,'')}${v.pctTxt !== '—' ? ' (' + v.pctTxt + ')' : ''}`);
    });
    lines.push(`<b>${rdEsc(t)}:</b> ` + (changed.length ? rdJoinAnd(changed) + '.' : 'no field changed.') + (changed.length && same.length ? ` Unchanged: ${rdJoinAnd(same)}.` : ''));
  });
  html += rdBullets(lines);

  // 2. Where each resource stands
  html += sec('Where each resource stands')
    + rdP(`${rdEsc(pair.cur.period)} compared with ${rdEsc(pair.prev.period)}.`)
    + rdStandsTable(ctx, pair.pi, 'vs last week');

  // 3. Variation by field
  html += sec('Variation by field');
  ctx.types.forEach((t,i) => {
    const c = ctx.totals(t, pair.curKey), p = ctx.totals(t, pair.prevKey);
    html += rdH3(`${n}.${i+1} ${t}`);
    if(!c || !p){ html += rdP('Not present in both weeks.'); return; }
    const rows = RD_FIELDS.map(f => {
      const v = rdVariation(f.get(c), f.get(p), f.kind);
      return [{ t: f.name, b: true, bg: '#f2f2f2' }, rdFmtKind(f.get(p), f.kind), rdFmtKind(f.get(c), f.kind),
        { t: v.diffTxt, c: true }, { t: v.pctTxt, c: true }, { t: v.dir, c: true, bg: RD_DIR_BG[v.dir] }];
    });
    html += rdTable(['Field', pair.prev.period, pair.cur.period, 'Difference', '% change', 'Direction'], rows);
  });

  // 4. Variation by source
  html += sec('Variation by source');
  ctx.types.forEach((t,i) => {
    const rows = rdSourceCompare(ctx, t, pair).map(x => {
      if(x.cur && !x.prev) return [{ t: x.label, b: true }, rdN(x.cur.src), { t: 'New source', c: true }, rdN(x.cur.gold), { t: 'New source', c: true }, rdPct(rdSingPct(x.cur), 2), { t: 'New source', c: true }, { t: x.cur.status || '—', c: true }];
      if(!x.cur) return [{ t: x.label, b: true }, '—', { t: 'Not in ' + pair.cur.period, c: true }, '—', { t: '—', c: true }, '—', { t: '—', c: true }, { t: '—', c: true }];
      const vs = rdVariation(Number(x.cur.src), Number(x.prev.src), 'int');
      const vg = rdVariation(Number(x.cur.gold), Number(x.prev.gold), 'int');
      const vr = rdVariation(rdSingPct(x.cur), rdSingPct(x.prev), 'pct');
      const cell = v => ({ t: v.dir === 'No change' ? 'No change' : v.diffTxt + (v.pctTxt !== '—' ? ' (' + v.pctTxt + ')' : ''), c: true, bg: RD_DIR_BG[v.dir] });
      return [{ t: x.label, b: true }, rdN(x.cur.src), cell(vs), rdN(x.cur.gold), cell(vg), rdPct(rdSingPct(x.cur), 2), cell(vr), { t: x.cur.status || '—', c: true }];
    });
    html += rdH3(`${n}.${i+1} ${t}`)
      + (rows.length ? rdTable(['Source','Source records','Change','Golden records','Change','Singleton rate','Change','Feed status'], rows) : rdP('No per-source rows in these weeks.'));
  });

  // 5. Trend across all weeks
  html += sec('Trend across all uploaded weeks')
    + rdP(`The dashboard graphs plot the same weeks as lines (${rdEsc(ctx.info.map(i => i.period).join(', '))}).`);
  ctx.types.forEach((t,i) => { html += rdH3(`${n}.${i+1} ${t}`) + rdProgressBlock(ctx, t); });

  html += sec('What to watch and confirm') + rdNumbered(rdWatchItems(ctx, pair.pi));
  html += sec('Notes on the numbers') + rdNotes(ctx);
  return rdWrap(title, `${title}  |  ${pair.prev.period} to ${pair.cur.period}`, html);
}

/* CSV with one line per resource / source and field: previous, current, difference, direction. */
function buildComparisonCsv(){
  const ctx = rdContext();
  const pair = rdComparePair(ctx);
  if(!pair) return null;
  const q = v => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g,'""') + '"' : s; };
  const out = [['scope','resource_type','source','field','previous_week','current_week','previous','current','difference','percent_change','direction']];
  const plain = (v, kind) => kind === 'int' ? String(Math.round(v)) : v.toFixed(kind === 'ratio' ? 4 : 2);
  const add = (scope, t, source, field, kind, p, c) => {
    const d = c - p;
    const v = rdVariation(c, p, kind);
    out.push([scope, t, source, field, pair.prev.period, pair.cur.period, plain(p, kind), plain(c, kind),
      (d > 0 ? '+' : '') + plain(d, kind), kind !== 'pct' && p > 0 ? (d >= 0 ? '+' : '') + (d / p * 100).toFixed(2) + '%' : '', v.dir]);
  };
  ctx.types.forEach(t => {
    const c = ctx.totals(t, pair.curKey), p = ctx.totals(t, pair.prevKey);
    if(c && p) RD_FIELDS.forEach(f => add('All sources', t, 'ALL', f.name, f.kind, f.get(p), f.get(c)));
    rdSourceCompare(ctx, t, pair).forEach(x => {
      if(!x.cur || !x.prev) { out.push(['Source', t, x.label, 'Presence', pair.prev.period, pair.cur.period, x.prev ? 'present' : 'absent', x.cur ? 'present' : 'absent', '', '', x.cur ? 'New source' : 'Not in current week']); return; }
      add('Source', t, x.label, 'Source records', 'int', Number(x.prev.src), Number(x.cur.src));
      add('Source', t, x.label, 'Golden records', 'int', Number(x.prev.gold), Number(x.cur.gold));
      add('Source', t, x.label, 'Singleton records', 'int', Number(x.prev.sing), Number(x.cur.sing));
      add('Source', t, x.label, 'Singleton rate', 'pct', rdSingPct(x.prev), rdSingPct(x.cur));
    });
  });
  return out.map(r => r.map(q).join(',')).join('\n');
}

function buildReportDoc(type){
  const ctx = rdContext();
  if(type === 'comparison') return rdComparison(ctx);
  if(type === 'daily') return rdDaily(ctx);
  if(type === 'monthly') return rdMonthly(ctx);
  return rdWeekly(ctx);
}
