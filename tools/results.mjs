#!/usr/bin/env node
/**
 * Deep Work Field evaluation table.
 *
 *   node tools/results.mjs --sessions <dir> --labels <labels.csv> [--out table.md]
 *
 * Session CSVs come from Study mode ("Export CSV" or the auto-download):
 *   session_id,timestamp_iso,elapsed_ms,type,state,mode,detail
 *
 * labels.csv is written by the independent labeler, blind to the mode:
 *   student,session_id,drift_onset_ms
 *   Ada,sess_123,31200
 *
 * Multiple labels per session are allowed. Results stay per student/session;
 * nothing is pooled into a single median.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, basename } from 'node:path';

function parseArgs(argv) {
  const args = { sessions: 'tools/samples', labels: 'tools/samples/labels.csv', out: '' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--sessions') args.sessions = argv[++i];
    else if (arg === '--labels') args.labels = argv[++i];
    else if (arg === '--out') args.out = argv[++i];
    else if (arg === '--demo') {
      args.sessions = 'tools/samples';
      args.labels = 'tools/samples/labels.csv';
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node tools/results.mjs --sessions <dir> --labels <labels.csv> [--out table.md] [--demo]');
      process.exit(0);
    }
  }
  return args;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((value) => value !== '')) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((value) => value !== '')) rows.push(row);
  return rows;
}

function readSession(path) {
  const rows = parseCsv(readFileSync(path, 'utf8'));
  const header = rows.shift() ?? [];
  const index = Object.fromEntries(header.map((name, i) => [name.trim(), i]));
  const events = rows.map((row) => ({
    sessionId: row[index.session_id] ?? '',
    elapsed: Number(row[index.elapsed_ms] ?? 0),
    type: row[index.type] ?? '',
    state: row[index.state] ?? '',
    mode: row[index.mode] ?? '',
    detail: row[index.detail] ?? '',
  }));
  return { path, events };
}

function labelsFor(path) {
  const rows = parseCsv(readFileSync(path, 'utf8'));
  const header = rows.shift() ?? [];
  const index = Object.fromEntries(header.map((name, i) => [name.trim().toLowerCase(), i]));
  return rows
    .map((row) => ({
      student: row[index.student] ?? '',
      sessionId: row[index.session_id] ?? '',
      onset: Number(row[index.drift_onset_ms] ?? NaN),
    }))
    .filter((row) => row.student && row.sessionId && Number.isFinite(row.onset));
}

const args = parseArgs(process.argv.slice(2));
if (!existsSync(args.labels)) {
  console.error(`Labels file not found: ${args.labels}`);
  process.exit(1);
}
if (!existsSync(args.sessions)) {
  console.error(`Sessions directory not found: ${args.sessions}`);
  process.exit(1);
}

const files = readdirSync(args.sessions)
  .filter((name) => name.endsWith('.csv') && resolve(args.sessions, name) !== resolve(args.labels))
  .map((name) => resolve(args.sessions, name));
const sessions = files.map(readSession);
const labels = labelsFor(args.labels);

function stateSpans(events) {
  const spans = [];
  let current = null;
  for (const event of events) {
    if (event.type !== 'state') continue;
    if (current) spans.push({ state: current.state, start: current.at, end: event.elapsed });
    current = { state: event.state, at: event.elapsed };
  }
  if (current) {
    const end = events.reduce((max, e) => Math.max(max, e.elapsed), current.at);
    spans.push({ state: current.state, start: current.at, end });
  }
  return spans;
}

function evaluate(label, session) {
  const events = session.events.filter((event) => event.sessionId === label.sessionId);
  if (!events.length) {
    return { ...label, missing: true };
  }
  const mode = events.find((event) => event.mode)?.mode ?? '';
  const duration = events.reduce((max, event) => Math.max(max, event.elapsed), 0);
  const after = events.filter((event) => event.elapsed >= label.onset);
  const edit = after.find((event) => event.type === 'first-edit');
  const nudges = events.filter((event) => event.type === 'nudge');
  const driftEvents = events.filter((event) => event.type === 'drift');
  const correctionEvents = events.filter((event) => event.type === 'correction');

  const nearLabel = (t) => Math.abs(t - label.onset) <= 10000;
  const falseNudges = nudges.filter((event) => !nearLabel(event.elapsed)).length;
  const hours = Math.max(duration / 3_600_000, 1 / 120);
  const driftDetected = driftEvents.some(
    (event) => event.elapsed >= label.onset - 1000 && event.elapsed <= label.onset + 15000,
  );
  const spans = stateSpans(events);
  const uncertainMs = spans
    .filter((span) => span.state === 'UNCERTAIN')
    .reduce((sum, span) => sum + Math.max(0, span.end - span.start), 0);
  const badNudgesPrevented = correctionEvents.filter((event) => /decision=on-task/.test(event.detail)).length;
  const realDriftsSuppressed = correctionEvents.filter((event) => /decision=drift/.test(event.detail)).length;

  return {
    ...label,
    mode,
    duration,
    firstEdit: edit ? edit.elapsed - label.onset : null,
    falseNudges,
    falseNudgesPerHour: falseNudges / hours,
    missed: !driftDetected,
    uncertainPct: duration ? (uncertainMs / duration) * 100 : 0,
    neverReturned: !edit,
    corrections: correctionEvents.length,
    badNudgesPrevented,
    realDriftsSuppressed,
    missing: false,
  };
}

const results = labels.map((label) => {
  const session = sessions.find((candidate) => candidate.events.some((event) => event.sessionId === label.sessionId));
  return session ? evaluate(label, session) : { ...label, missing: true };
});

const fmt = (value, digits = 1) => (value === null || value === undefined || Number.isNaN(value) ? '—' : Number(value).toFixed(digits));
const rows = [
  ['Student', 'Session', 'Mode', 'Duration', 'First edit after drift (s)', 'False nudges / h', 'Missed drift', 'UNCERTAIN %', 'Never returned', 'Corrections'],
];
for (const result of results) {
  if (result.missing) {
    rows.push([result.student, result.sessionId, '—', '—', '—', '—', '—', '—', '—', 'session CSV missing']);
    continue;
  }
  rows.push([
    result.student,
    result.sessionId,
    result.mode || '—',
    `${Math.round(result.duration / 1000)}s`,
    result.firstEdit === null ? '—' : fmt(result.firstEdit / 1000),
    fmt(result.falseNudgesPerHour, 2),
    result.missed ? 'yes' : 'no',
    fmt(result.uncertainPct),
    result.neverReturned ? 'yes' : 'no',
    String(result.corrections),
  ]);
}
const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => String(row[column]).length)));
const tableLines = rows.map((row) => `| ${row.map((cell, index) => String(cell).padEnd(widths[index])).join(' | ')} |`);
tableLines.splice(1, 0, `| ${widths.map((width) => '-'.repeat(width)).join(' | ')} |`);
const markdown = tableLines.join('\n');

const summary = [
  `Sessions: ${new Set(results.filter((r) => !r.missing).map((r) => r.sessionId)).size}`,
  `Students: ${new Set(results.map((r) => r.student)).size}`,
  `Missed drifts: ${results.filter((r) => !r.missing && r.missed).length}/${results.filter((r) => !r.missing).length}`,
  `Never returned: ${results.filter((r) => !r.missing && r.neverReturned).length}`,
  `Correction decisions logged: ${results.reduce((sum, r) => sum + (r.corrections ?? 0), 0)}`,
  `Bad nudges prevented: ${results.reduce((sum, r) => sum + (r.badNudgesPrevented ?? 0), 0)}`,
  `Real drifts restored: ${results.reduce((sum, r) => sum + (r.realDriftsSuppressed ?? 0), 0)}`,
].join('\n');

console.log(markdown);
console.log(`\n${summary}`);
if (args.out) {
  writeFileSync(resolve(args.out), `${markdown}\n\n${summary}\n`);
  console.log(`\nWrote ${resolve(args.out)}`);
}
