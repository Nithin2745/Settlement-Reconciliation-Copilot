// src/dashboard/public/app.js
//
// The dashboard's whole client. No framework, no build step, no bundler — it is
// served as-is by src/dashboard/server.js.
//
// Two rules it holds to:
//   1. Nothing from the database is ever written as HTML. Every value goes in
//      through textContent or a created element. An audit trail renders strings
//      that came from a bank narration and an LLM response; innerHTML on that
//      input is how a viewer becomes an injection surface.
//   2. Every number on the page is traceable to one field of the JSON the API
//      returned. The only things re-derived client-side are the percentages and
//      the amount deltas — and a delta is the subtraction of two fields that are
//      both on the page themselves, in the drawer, so it can be checked by eye
//      rather than trusted. The partition tiles are computed from
//      byResolutionPath alone so they add up to the record count exactly.
//
// Money is stored in the trail as integer paise and rendered as rupees. Null and
// zero are different answers everywhere it appears: a null bank amount means no
// bank line was matched, a zero delta means one was and the money agreed.

// Order is the pipeline's own order, not alphabetical: rules first, then the
// escalation outcomes in decreasing degree of resolution.
const PATH_ORDER = [
  'RULE_ONLY',
  'LLM_ACCEPTED',
  'LLM_FLAGGED',
  'LLM_REJECTED',
  'LLM_ERROR',
  'LLM_SKIPPED',
];

const PATH_COLOUR = {
  RULE_ONLY: 'var(--p-rule)',
  LLM_ACCEPTED: 'var(--p-accepted)',
  LLM_FLAGGED: 'var(--p-flagged)',
  LLM_REJECTED: 'var(--p-rejected)',
  LLM_ERROR: 'var(--p-error)',
  LLM_SKIPPED: 'var(--p-skipped)',
};

const PATH_BLURB = {
  RULE_ONLY: 'deterministic engine settled it; no model involved',
  LLM_ACCEPTED: 'model proposed, the gate accepted',
  LLM_FLAGGED: 'below the confidence threshold — human decides',
  LLM_REJECTED: 'the gate threw the decision out',
  LLM_ERROR: 'both providers failed for this record',
  LLM_SKIPPED: 'no candidate to offer, so no call was made',
};

// Must equal the number of <th> in index.html: it is the colSpan of both
// empty-state cells, and a table whose empty row spans the wrong width breaks
// visibly while every test still passes. Named once so adding a column is one
// edit here and one in the markup, not a hunt for stray literals.
const COLUMN_COUNT = 10;

const state = {
  runs: [],
  runId: null,
  progress: null,
  rows: [],
  selectedId: null,
  pollMs: 2000,
  timer: null,
};
const $ = (id) => document.getElementById(id);

function el(tag, className, textContent) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (textContent !== undefined && textContent !== null) node.textContent = String(textContent);
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

// A rate the evaluator could not compute comes back as null rather than 0 (an
// empty denominator is not a score of zero), so render it as unknown, not 0.0%.
function pct(value, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

function num(value) {
  if (value === null || value === undefined) return '—';
  return String(value);
}

// Amounts live in the trail as integer paise — the only sane way to hold money in
// a database column — and have to reach a reviewer as rupees, which is the only
// way money gets read. Negatives are real, not errors: a refund or a transfer
// settles as money out.
const RUPEES = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function money(paise) {
  if (paise === null || paise === undefined || paise === '') return '—';
  const n = Number(paise);
  if (!Number.isFinite(n)) return '—';
  return RUPEES.format(n / 100);
}

// A delta's sign is the whole point — "the bank credited ₹6,503 MORE than the
// settlement claimed" and "₹6,503 less" are different investigations — so the
// sign is rendered explicitly rather than left to the formatter's minus.
function signedMoney(paise) {
  const n = Number(paise);
  if (!Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  return sign + RUPEES.format(Math.abs(n) / 100);
}

/**
 * What one source said versus the settlement field it is supposed to agree with,
 * or null when there is nothing to compare. Null is not zero here: no bank match
 * means the question was never asked, while a zero delta means it was asked and
 * the money agreed.
 *
 * Which field is the baseline is the caller's business, and it is not the same for
 * both sides — see amountCell().
 */
function delta(baseline, stated) {
  if (baseline === null || baseline === undefined) return null;
  if (stated === null || stated === undefined) return null;
  const a = Number(baseline);
  const b = Number(stated);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return b - a;
}

function shortTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status} from ${url}`);
  return body;
}

function banner(message, isError = false) {
  const node = $('banner');
  node.textContent = message || '';
  node.classList.toggle('is-error', Boolean(isError));
  node.hidden = !message;
}
/* ---------- loading ---------- */

async function loadRuns() {
  const data = await fetchJson('/api/runs');
  state.runs = data.runs || [];
  if (Number.isFinite(data.pollMs)) state.pollMs = data.pollMs;
  if (data.host) $('foot-host').textContent = data.host;

  const select = $('run-select');
  clear(select);

  if (!state.runs.length) {
    select.appendChild(el('option', null, 'no runs yet'));
    select.disabled = true;
    banner(
      'The audit trail is empty. Run `npm run run-pipeline -- 120 42` and this page will fill in as it writes.'
    );
    return;
  }

  select.disabled = false;
  for (const run of state.runs) {
    const label =
      `#${run.id} · ${run.batch_size ?? '?'} records · seed ${run.seed ?? '—'} · ` +
      `${run.source}/${run.ingest_mode} · ${run.status}`;
    const option = el('option', null, label);
    option.value = String(run.id);
    select.appendChild(option);
  }

  // Keep the operator's choice across a poll; otherwise open on the newest run,
  // which is what listRuns() returns first.
  const stillThere = state.runs.some((r) => r.id === state.runId);
  if (!stillThere) state.runId = state.runs[0].id;
  select.value = String(state.runId);
}

async function loadRun(runId) {
  const [progress, rowsPayload] = await Promise.all([
    fetchJson(`/api/runs/${runId}`),
    fetchJson(`/api/runs/${runId}/rows`),
  ]);
  state.progress = progress;
  state.rows = (rowsPayload.rows || []).map(withHaystack);
}
// Built once per row on load so filtering 120 rows on every keystroke is a
// substring test rather than a walk over twenty-odd fields.
function withHaystack(row) {
  const parts = [
    row.entity_id,
    row.entity_type,
    // The search box has always offered "UTR" in its placeholder. Until the trail
    // stored one, that promise silently matched nothing.
    row.settlement_utr,
    row.status,
    row.confidence_tier,
    row.bank_match_id,
    row.bank_match_method,
    row.ledger_match_id,
    row.ledger_match_method,
    row.resolution_path,
    row.unresolved_reason,
    row.llm_provider,
    row.llm_decision,
    row.llm_candidate_id,
    row.validation_reason,
    row.eval_case_type,
    row.eval_verdict,
    (row.signals_json || []).join(' '),
    (row.llm_reason_codes || []).join(' '),
    (row.llm_raw_reason_codes || []).join(' '),
    (row.validation_warnings || []).join(' '),
  ];
  return { ...row, _hay: parts.filter(Boolean).join(' ').toLowerCase() };
}

async function refresh({ reloadRuns = true } = {}) {
  try {
    if (reloadRuns) await loadRuns();
    if (state.runId === null) {
      state.progress = null;
      state.rows = [];
      renderEmpty();
      return;
    }
    await loadRun(state.runId);
    banner('');
    render();
  } catch (err) {
    banner(err.message, true);
  } finally {
    scheduleNextPoll();
  }
}

// Poll only while the pipeline is still writing this run. A finished run is
// immutable, so polling it would be three queries a second for no new facts.
function scheduleNextPoll() {
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  const isLive = state.progress && state.progress.run && state.progress.run.status === 'running';
  $('live-badge').hidden = !isLive;
  if (isLive) state.timer = setTimeout(() => refresh({ reloadRuns: true }), state.pollMs);
}
/* ---------- rendering ---------- */

function renderEmpty() {
  clear($('tiles'));
  clear($('path-bar'));
  clear($('path-legend'));
  clear($('scorecards'));
  const row = el('tr');
  const cell = el('td', 'empty', 'No runs in the audit trail yet.');
  cell.colSpan = COLUMN_COUNT;
  row.appendChild(cell);
  clear($('rows-body')).appendChild(row);
  $('row-count').textContent = '';
  $('run-meta').textContent = '';
}

function tile(label, value, sub, tone) {
  const node = el('div', tone ? `tile ${tone}` : 'tile');
  node.appendChild(el('div', 'tile-label', label));
  node.appendChild(el('div', 'tile-value', value));
  if (sub) node.appendChild(el('div', 'tile-sub', sub));
  return node;
}

function render() {
  renderMeta();
  renderTiles();
  renderPathBar();
  renderScorecards();
  renderFilterOptions();
  renderTable();
  const base = `/api/runs/${state.runId}`;
  $('export-csv').href = `${base}/export.csv`;
  $('export-json').href = `${base}/export.json`;
}

function renderMeta() {
  const { run } = state.progress;
  const bits = [
    `run #${run.id}`,
    `${run.status}`,
    `started ${shortTime(run.started_at)}`,
    run.finished_at ? `finished ${shortTime(run.finished_at)}` : 'still writing',
    `ingest: ${run.ingest_mode}`,
    `source: ${run.source}`,
  ];
  $('run-meta').textContent = bits.join('  ·  ');
  if (run.error) banner(`This run recorded an error: ${run.error}`, true);
}
function renderTiles() {
  const { total, byResolutionPath: paths, run } = state.progress;
  const summary = run.summary;
  const box = clear($('tiles'));
  const at = (key) => paths[key] || 0;
  const share = (n) => (total ? pct(n / total) : '—');

  // These three partition the batch by construction: every record has exactly
  // one resolution_path, so ruleOnly + accepted + held === total, always.
  const ruleOnly = at('RULE_ONLY');
  const accepted = at('LLM_ACCEPTED');
  const held = total - ruleOnly - accepted;

  box.appendChild(
    tile(
      'Records',
      total,
      run.status === 'running'
        ? `of ${num(run.batch_size)} — still writing`
        : `seed ${num(run.seed)} · ${run.source}`
    )
  );
  box.appendChild(
    tile('Resolved by rules', ruleOnly, `${share(ruleOnly)} — never reached a model`, 'good')
  );
  box.appendChild(
    tile('AI decision accepted', accepted, `${share(accepted)} — proposal cleared the gate`)
  );
  box.appendChild(
    tile('Held for a human', held, `${share(held)} — flagged, rejected, errored or skipped`, 'human')
  );

  if (!summary) {
    box.appendChild(tile('Scorecard', '—', 'graded once the run finishes', 'warn'));
    return;
  }

  const misses = summary.deterministic.silentMisses;
  box.appendChild(
    tile('Silent misses', misses, 'missed AND not flagged', misses ? 'bad' : 'good')
  );
  const fp = summary.ai.falsePositives;
  box.appendChild(
    tile(
      'AI match precision',
      pct(summary.ai.matchPrecision),
      `${num(summary.ai.namedDecisions)} named · ${num(fp)} false positive${fp === 1 ? '' : 's'}`,
      fp ? 'bad' : 'good'
    )
  );
}
function renderPathBar() {
  const { total, byResolutionPath: paths } = state.progress;
  const bar = clear($('path-bar'));
  const legend = clear($('path-legend'));
  const present = PATH_ORDER.filter((key) => (paths[key] || 0) > 0);

  // Any path the pipeline emits that PATH_ORDER does not know about must still
  // show up, or the bar would silently stop summing to the record count.
  for (const key of Object.keys(paths)) {
    if (!present.includes(key) && (paths[key] || 0) > 0) present.push(key);
  }

  if (!total || !present.length) {
    bar.appendChild(el('span', 'empty', 'no rows yet'));
    return;
  }

  for (const key of present) {
    const count = paths[key];
    const segment = el('span');
    segment.style.flexBasis = `${(count / total) * 100}%`;
    segment.style.background = PATH_COLOUR[key] || 'var(--p-skipped)';
    // Only label the segment if it is wide enough to read; the legend carries
    // the rest.
    segment.textContent = count / total > 0.07 ? `${key.replace('LLM_', '')} ${count}` : '';
    segment.title = `${key}: ${count} (${pct(count / total)})`;
    bar.appendChild(segment);

    const item = el('li');
    const swatch = el('span', 'swatch');
    swatch.style.background = PATH_COLOUR[key] || 'var(--p-skipped)';
    item.appendChild(swatch);
    item.appendChild(el('b', null, `${key} ${count}`));
    item.appendChild(el('span', null, `(${pct(count / total)}) — ${PATH_BLURB[key] || ''}`));
    legend.appendChild(item);
  }
}

function card(title, note) {
  const node = el('div', 'card');
  node.appendChild(el('h3', null, title));
  if (note) node.appendChild(el('p', 'card-note', note));
  return node;
}

function kv(list, label, value, tone) {
  list.appendChild(el('dt', null, label));
  list.appendChild(el('dd', tone || null, value));
}
function renderScorecards() {
  const { run, total, byStatus, evalVerdicts } = state.progress;
  const summary = run.summary;
  const box = clear($('scorecards'));

  // Always available, live or finished: this one is counted in SQL.
  const statusCard = card('Match status', 'what the deterministic engine could tie together');
  const statusList = el('dl', 'kv');
  for (const [status, count] of Object.entries(byStatus)) {
    kv(statusList, status, `${count} (${total ? pct(count / total) : '—'})`);
  }
  if (!Object.keys(byStatus).length) kv(statusList, 'no rows yet', '—');
  statusCard.appendChild(statusList);
  box.appendChild(statusCard);

  if (evalVerdicts) {
    const verdictCard = card(
      'Ground-truth verdicts',
      'only accepted AI decisions are graded — a flagged record has no verdict to grade'
    );
    const list = el('dl', 'kv');
    for (const key of ['CORRECT', 'WRONG', 'MISSED']) {
      if (evalVerdicts[key] === undefined) continue;
      const tone = key === 'CORRECT' ? 'good' : key === 'WRONG' ? 'bad' : 'warn';
      kv(list, key, evalVerdicts[key], tone);
    }
    verdictCard.appendChild(list);
    box.appendChild(verdictCard);
  }

  if (!summary) {
    const pending = card(
      'Scorecard pending',
      run.status === 'running'
        ? `${total} of ${num(run.batch_size)} records written. The evaluation runs when the batch finishes.`
        : 'This run stored no evaluation summary. A live-API run has no answer key to grade against.'
    );
    box.appendChild(pending);
    return;
  }

  renderDeterministicCard(box, summary.deterministic);
  renderAiCard(box, summary.ai, summary.pipeline);
}
function renderDeterministicCard(box, d) {
  const node = card('Deterministic layer', 'rules only — this half of the run has no model in it');
  const list = el('dl', 'kv');
  kv(list, 'Claim precision', `${pct(d.precision)} (${d.correctClaims}/${d.claims})`, d.wrongClaims ? 'bad' : 'good');
  kv(list, 'Silent misses', d.silentMisses, d.silentMisses ? 'bad' : 'good');
  kv(list, 'Silent wrong claims', d.silentWrongClaims, d.silentWrongClaims ? 'bad' : 'good');
  kv(list, 'Escalation recall', pct(d.recall), d.recall === 1 ? 'good' : 'warn');
  kv(list, 'Correctly escalated', d.correctlyEscalated);
  kv(list, 'Over-escalated', `${d.overEscalated} (${pct(d.overEscalationRate)})`, 'warn');
  kv(list, 'Clean and left alone', d.correctlyClean);
  node.appendChild(list);
  box.appendChild(node);
}

function renderAiCard(box, ai, pipeline) {
  const node = card('LLM exception layer', 'proposals only — every one of these passed through the gate');
  const list = el('dl', 'kv');
  kv(list, 'Match precision', `${pct(ai.matchPrecision)} (${ai.namedDecisions} named)`, ai.falsePositives ? 'bad' : 'good');
  kv(list, 'False positives', ai.falsePositives, ai.falsePositives ? 'bad' : 'good');
  kv(list, 'Decision accuracy', `${pct(ai.decisionAccuracy)} (${ai.acceptedDecisions} accepted)`);
  kv(list, 'Flagged below threshold', ai.flaggedLowConfidence, 'warn');
  kv(list, 'Rejected by the gate', ai.rejectedByValidator, ai.rejectedByValidator ? 'warn' : 'good');
  kv(list, 'Provider errors', ai.llmErrors, ai.llmErrors ? 'bad' : 'good');
  kv(list, 'Calls avoided', `${ai.skippedNoCandidates} (${pct(ai.llmCallAvoidanceRate ?? pipeline.llmCallAvoidanceRate)})`);
  kv(list, 'End-to-end coverage', pct(pipeline.endToEndCoverage), 'good');
  node.appendChild(list);
  box.appendChild(node);

  const reasons = ai.validatorRejectionReasons || {};
  if (!Object.keys(reasons).length) return;
  const why = card('Why the gate rejected', 'the reason each discarded decision failed validation');
  const whyList = el('dl', 'kv');
  for (const [reason, count] of Object.entries(reasons)) kv(whyList, reason, count, 'warn');
  why.appendChild(whyList);
  box.appendChild(why);
}
/* ---------- filters ---------- */

function fillSelect(select, values, order) {
  const keep = select.value;
  const sorted = order
    ? [...values].sort((a, b) => {
        const ia = order.indexOf(a);
        const ib = order.indexOf(b);
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
      })
    : [...values].sort();
  clear(select);
  select.appendChild(Object.assign(el('option', null, 'all'), { value: '' }));
  for (const value of sorted) {
    select.appendChild(Object.assign(el('option', null, value), { value }));
  }
  // A filter the operator set must survive a poll, but not a value that no
  // longer exists in the run they switched to.
  select.value = sorted.includes(keep) ? keep : '';
}

function renderFilterOptions() {
  const uniq = (key) => [...new Set(state.rows.map((r) => r[key]).filter(Boolean))];
  fillSelect($('f-path'), uniq('resolution_path'), PATH_ORDER);
  fillSelect($('f-status'), uniq('status'));
  fillSelect($('f-verdict'), uniq('eval_verdict'), ['CORRECT', 'WRONG', 'MISSED']);
}

function visibleRows() {
  const path = $('f-path').value;
  const status = $('f-status').value;
  const verdict = $('f-verdict').value;
  const needle = $('f-search').value.trim().toLowerCase();
  return state.rows.filter((row) => {
    if (path && row.resolution_path !== path) return false;
    if (status && row.status !== status) return false;
    if (verdict && row.eval_verdict !== verdict) return false;
    if (needle && !row._hay.includes(needle)) return false;
    return true;
  });
}
/* ---------- table ---------- */

function matchCell(id, method) {
  const cell = el('td');
  if (!id) {
    cell.appendChild(el('span', 'dim', '—'));
    return cell;
  }
  cell.appendChild(el('span', 'mono', id));
  if (method) cell.appendChild(el('span', 'method', method));
  return cell;
}

function pill(value) {
  return el('span', `pill pill-${value}`, value);
}

/**
 * Net settled amount, with a disagreement called out underneath it.
 *
 * Each source is compared against the settlement field it is supposed to match,
 * and that field is NOT the same for both: a bank credit should equal the net
 * settled, a ledger entry should equal the gross order value raised before fees
 * and tax. This mirrors AMOUNT_FIELD_BY_SOURCE in src/matcher/matchEngine.js.
 * Comparing both sides to net would print a red delta of exactly fee + tax on
 * every clean record — the opposite of the point, which is that any red in this
 * column is a real money problem and not arithmetic the reader has to undo.
 *
 * The delta line appears only when a counterparty amount exists AND differs, so
 * the common case stays one line and a scan down the column finds the money
 * problems rather than reading 120 rows of confirmation. "Was there a match at
 * all" is already answered by the adjacent Bank/Ledger match columns.
 *
 * Bank wins when both sides disagree: the bank is where money actually moved, the
 * ledger is what someone intended to invoice. The drawer shows both in full.
 *
 * The cue is in this cell rather than tinting the whole <tr> on purpose — rows are
 * already tinted by ground-truth verdict, and two tint systems on one row make
 * both unreadable.
 */
function amountCell(row) {
  const cell = el('td', 'amount');
  cell.appendChild(el('span', 'amount-net', money(row.net_amount)));

  const bankDelta = delta(row.net_amount, row.bank_amount);
  const ledgerDelta = delta(row.gross_amount, row.ledger_amount);
  const [side, value, stated, baseline, baselineLabel] =
    bankDelta !== null && bankDelta !== 0
      ? ['bank', bankDelta, row.bank_amount, row.net_amount, 'net']
      : ledgerDelta !== null && ledgerDelta !== 0
        ? ['ledger', ledgerDelta, row.ledger_amount, row.gross_amount, 'gross']
        : [null, null, null, null, null];

  if (side) {
    const note = el('span', 'amount-delta');
    note.appendChild(el('span', 'delta-side', side));
    note.appendChild(el('span', null, `Δ ${signedMoney(value)}`));
    note.title = `${side} says ${money(stated)}, this settlement's ${baselineLabel} is ${money(baseline)}`;
    cell.appendChild(note);
  }
  return cell;
}

function renderTable() {
  const body = clear($('rows-body'));
  const rows = visibleRows();

  $('row-count').textContent =
    rows.length === state.rows.length
      ? `${rows.length} records`
      : `${rows.length} of ${state.rows.length} records`;

  if (!rows.length) {
    const tr = el('tr');
    const td = el('td', 'empty', 'No records match these filters.');
    td.colSpan = COLUMN_COUNT;
    tr.appendChild(td);
    body.appendChild(tr);
    return;
  }

  for (const row of rows) body.appendChild(buildRow(row));
}
function buildRow(row) {
  const tr = el('tr', row.eval_verdict ? `verdict-${row.eval_verdict}` : null);
  if (state.selectedId === row.id) tr.classList.add('is-selected');

  // A real <button>, not a click handler on the <tr>: the whole table stays
  // reachable by keyboard and announces what activating it does. The row id rides
  // along in a data attribute so closeDrawer() can find this exact button again
  // after the table has been rebuilt underneath it.
  const first = el('td');
  const open = el('button', 'cell-btn mono', row.entity_id);
  open.type = 'button';
  open.dataset.rowId = String(row.id);
  open.setAttribute('aria-label', `Show the full trail for ${row.entity_id}`);
  open.addEventListener('click', () => openDrawer(row.id));
  first.appendChild(open);
  first.appendChild(el('span', 'method', row.entity_type));
  tr.appendChild(first);

  tr.appendChild(amountCell(row));
  tr.appendChild(el('td', null, row.status));
  tr.appendChild(el('td', `tier-${row.confidence_tier}`, row.confidence_tier));
  tr.appendChild(matchCell(row.bank_match_id, row.bank_match_method));
  tr.appendChild(matchCell(row.ledger_match_id, row.ledger_match_method));

  const pathCell = el('td');
  pathCell.appendChild(pill(row.resolution_path));
  tr.appendChild(pathCell);

  const llmCell = el('td');
  if (row.llm_decision) {
    llmCell.appendChild(el('span', null, row.llm_decision));
    if (row.llm_provider) llmCell.appendChild(el('span', 'method', row.llm_provider));
  } else {
    llmCell.appendChild(el('span', 'dim', '—'));
  }
  tr.appendChild(llmCell);

  tr.appendChild(
    el('td', null, row.llm_confidence === null ? '—' : Number(row.llm_confidence).toFixed(2))
  );
  tr.appendChild(
    el('td', row.eval_verdict ? `v-${row.eval_verdict}` : 'dim', row.eval_verdict || '—')
  );
  return tr;
}
/* ---------- detail drawer ---------- */

function section(parent, heading) {
  parent.appendChild(el('h4', null, heading));
  const list = el('dl', 'kv');
  parent.appendChild(list);
  return list;
}

function codeList(parent, accepted, raw) {
  const box = el('div', 'codes');
  const kept = accepted || [];
  for (const code of kept) box.appendChild(el('span', 'code', code));
  // Anything the model sent that the gate removed. ADR-002 drops an unsupported
  // reason code and keeps the decision; showing both is what makes that edit
  // auditable rather than invisible.
  for (const code of raw || []) {
    if (!kept.includes(code)) box.appendChild(el('span', 'code dropped', code));
  }
  if (!box.childNodes.length) box.appendChild(el('span', 'dim', 'none'));
  parent.appendChild(box);
}

function openDrawer(rowId) {
  const row = state.rows.find((r) => r.id === rowId);
  if (!row) return;
  state.selectedId = rowId;
  renderTable();

  $('drawer-h').textContent = row.entity_id;
  const body = clear($('drawer-body'));

  // Money first. Everything below this is about which records were tied together;
  // this is the only section that says whether the amounts actually agreed, which
  // is the question the whole tool exists to answer.
  const cash = section(body, 'Money — what each source said');
  kv(cash, 'Settlement UTR', row.settlement_utr || '—');
  kv(cash, 'Gross', money(row.gross_amount));
  kv(cash, 'Fee', money(row.fee));
  kv(cash, 'Tax', money(row.tax));
  kv(cash, 'Net settled', money(row.net_amount));

  // Baselines differ per side, as in amountCell(): the bank credits the net, the
  // ledger records the gross. The label names which one it was measured against so
  // the number can be checked against the four rows directly above it by eye.
  for (const [label, stated, baseline, baselineLabel] of [
    ['Bank credited', row.bank_amount, row.net_amount, 'net'],
    ['Ledger recorded', row.ledger_amount, row.gross_amount, 'gross'],
  ]) {
    const d = delta(baseline, stated);
    if (d === null) {
      kv(cash, label, stated === null || stated === undefined ? 'no match on this side' : money(stated));
      continue;
    }
    kv(cash, label, money(stated));
    kv(
      cash,
      `vs ${baselineLabel}`,
      d === 0 ? 'agrees exactly' : signedMoney(d),
      d === 0 ? 'good' : 'bad'
    );
  }

  const match = section(body, 'Deterministic match');
  kv(match, 'Status', row.status);
  kv(match, 'Confidence tier', row.confidence_tier);
  kv(match, 'Bank', row.bank_match_id || '—');
  kv(match, 'Bank method', row.bank_match_method || '—');
  kv(match, 'Ledger', row.ledger_match_id || '—');
  kv(match, 'Ledger method', row.ledger_match_method || '—');
  if (row.unresolved_reason) kv(match, 'Unresolved reason', row.unresolved_reason, 'warn');

  body.appendChild(el('h4', null, 'Signals the engine raised'));
  codeList(body, row.signals_json, null);
  const route = section(body, 'Resolution path');
  route.appendChild(el('dt', null, 'Path'));
  const pathDd = el('dd');
  pathDd.appendChild(pill(row.resolution_path));
  route.appendChild(pathDd);
  kv(route, 'What that means', PATH_BLURB[row.resolution_path] || '—');

  if (row.resolution_path !== 'RULE_ONLY') {
    const llm = section(body, 'LLM proposal');
    kv(llm, 'Provider', row.llm_provider || '—');
    kv(llm, 'Decision', row.llm_decision || '—');
    kv(llm, 'Candidate', row.llm_candidate_id || '—');
    kv(
      llm,
      'Confidence',
      row.llm_confidence === null ? '—' : Number(row.llm_confidence).toFixed(2)
    );

    const gate = section(body, 'Validation gate');
    kv(
      gate,
      'Outcome',
      row.validation_reason || '—',
      row.validation_reason === 'OK' ? 'good' : 'warn'
    );
    gate.appendChild(el('dt', null, 'Warnings'));
    const warnDd = el('dd');
    warnDd.textContent = (row.validation_warnings || []).length
      ? String(row.validation_warnings.length)
      : row.validation_warnings === null
        ? 'not recorded'
        : 'none';
    gate.appendChild(warnDd);

    if ((row.validation_warnings || []).length) {
      body.appendChild(el('h4', null, 'Gate warnings'));
      codeList(body, row.validation_warnings, null);
    }

    body.appendChild(el('h4', null, 'Reason codes — kept, and dropped'));
    codeList(body, row.llm_reason_codes, row.llm_raw_reason_codes);
  }
  if (row.eval_case_type || row.eval_verdict) {
    const evaluation = section(body, 'Ground truth (synthetic runs only)');
    kv(evaluation, 'Case type', row.eval_case_type || '—');
    const tone =
      row.eval_verdict === 'CORRECT' ? 'good' : row.eval_verdict === 'WRONG' ? 'bad' : 'warn';
    kv(evaluation, 'Verdict', row.eval_verdict || 'not graded', row.eval_verdict ? tone : null);
  }

  const provenance = section(body, 'Provenance');
  kv(provenance, 'Audit row', `#${row.id}`);
  kv(provenance, 'Run', `#${row.run_id}`);
  kv(provenance, 'Written at', shortTime(row.created_at));

  $('drawer').hidden = false;
  $('drawer-close').focus();
}

function closeDrawer() {
  const drawer = $('drawer');
  if (drawer.hidden) return;

  // renderTable() below destroys the button that opened the drawer, so without a
  // deliberate hand-off a keyboard user loses their place in a 120-row table on
  // every close: focus falls to <body> and the next Tab restarts from the top of
  // the page. Remember which row to go back to before the id is cleared.
  const returnTo = state.selectedId;
  // ...but only take focus if focus is somewhere that is about to disappear.
  // Escape also closes the drawer while the operator is typing in the search box,
  // and yanking the caret out of that field would be worse than the bug.
  const shouldRestore =
    drawer.contains(document.activeElement) || document.activeElement === document.body;

  drawer.hidden = true;
  state.selectedId = null;
  renderTable();

  if (!shouldRestore || !Number.isInteger(returnTo)) return;
  const button = $('rows-body').querySelector(`.cell-btn[data-row-id="${returnTo}"]`);
  if (button) button.focus();
}

/* ---------- wiring ---------- */

$('run-select').addEventListener('change', (event) => {
  const value = event.target.value;
  state.runId = value === '' ? null : Number(value);
  state.selectedId = null;
  closeDrawer();
  refresh({ reloadRuns: false });
});

$('refresh').addEventListener('click', () => refresh({ reloadRuns: true }));
$('drawer-close').addEventListener('click', closeDrawer);

for (const id of ['f-path', 'f-status', 'f-verdict']) {
  $(id).addEventListener('change', renderTable);
}
$('f-search').addEventListener('input', renderTable);

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('drawer').hidden) closeDrawer();
});

refresh({ reloadRuns: true });
