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

/** Greedy one-to-one matching: each event goes to the closest unmatched label in its window. */
function matchEvents(times, onsets, before = 1000, after = 15000) {
  const owner = new Map(); // label index -> event time
  const unmatched = [];
  for (const t of times) {
    let best = -1;
    for (let i = 0; i < onsets.length; i++) {
      if (owner.has(i)) continue;
      if (t < onsets[i] - before || t > onsets[i] + after) continue;
      if (best === -1 || Math.abs(t - onsets[i]) < Math.abs(t - onsets[best])) best = i;
    }
    if (best === -1) unmatched.push(t);
    else owner.set(best, t);
  }
  return { owner, unmatched };
}

function modeAt(events, t) {
  let mode = '';
  for (const e of events) {
    if (e.elapsed > t) break;
    if (e.mode) mode = e.mode;
  }
  return mode;
}

/**
 * Evaluates one session against ALL of its labels at once, so a nudge for
 * one drift episode can never count as "false" in another episode's row,
 * and one edit can only count as the return for the episode it falls in.
 */
function evaluateSession(sessionId, sessionLabels, events) {
  events = [...events].sort((x, y) => x.elapsed - y.elapsed);
  const labelsSorted = [...sessionLabels].sort((x, y) => x.onset - y.onset);
  const onsets = labelsSorted.map((l) => l.onset);
  const duration = events.reduce((max, e) => Math.max(max, e.elapsed), 0);
  const nudges = matchEvents(events.filter((e) => e.type === 'nudge').map((e) => e.elapsed), onsets);
  const drifts = matchEvents(events.filter((e) => e.type === 'drift').map((e) => e.elapsed), onsets);
  const edits = events.filter((e) => e.type === 'first-edit').map((e) => e.elapsed);
  const incomplete = events.some((e) => e.type === 'session-end' && /INCOMPLETE/.test(e.detail));
  const spans = stateSpans(events);
  const uncertainMs = spans.filter((sp) => sp.state === 'UNCERTAIN').reduce((sum, sp) => sum + Math.max(0, sp.end - sp.start), 0);
  const hours = Math.max(duration / 3_600_000, 1 / 120);
  const episodes = labelsSorted.map((label, i) => {
    const windowEnd = i + 1 < onsets.length ? onsets[i + 1] : Infinity;
    const edit = edits.find((t) => t >= label.onset && t < windowEnd);
    return {
      ...label,
      episode: i + 1,
      mode: modeAt(events, label.onset),
      detected: drifts.owner.has(i),
      nudged: nudges.owner.has(i),
      firstEdit: edit === undefined ? null : edit - label.onset,
    };
  });
  return {
    sessionId,
    student: labelsSorted[0]?.student ?? '',
    duration,
    episodes,
    falseNudges: nudges.unmatched.length,
    falseNudgesPerHour: nudges.unmatched.length / hours,
    uncertainPct: duration ? (uncertainMs / duration) * 100 : 0,
    corrections: events.filter((e) => e.type === 'correction').length,
    incomplete,
  };
}

const bySession = new Map();
for (const label of labels) {
  if (!bySession.has(label.sessionId)) bySession.set(label.sessionId, []);
  bySession.get(label.sessionId).push(label);
}
const allEvents = sessions.flatMap((sess) => sess.events);
const evaluated = [];
const missing = [];
for (const [sessionId, sessionLabels] of bySession) {
  const events = allEvents.filter((e) => e.sessionId === sessionId);
  if (!events.length) missing.push(sessionId);
  else evaluated.push(evaluateSession(sessionId, sessionLabels, events));
}
const labelledIds = new Set(bySession.keys());
const unlabeled = [...new Set(allEvents.map((e) => e.sessionId))].filter((id) => id && !labelledIds.has(id));

const fmt = (value, digits = 1) => (value === null || value === undefined || Number.isNaN(value) ? '—' : Number(value).toFixed(digits));
function table(rows) {
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => String(r[c]).length)));
  const lines = rows.map((r) => `| ${r.map((cell, i) => String(cell).padEnd(widths[i])).join(' | ')} |`);
  lines.splice(1, 0, `| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`);
  return lines.join('\n');
}

const episodeRows = [['Student', 'Session', 'Episode', 'Mode at onset', 'Drift detected', 'Nudged', 'First edit after onset (s)']];
for (const sess of evaluated) {
  for (const ep of sess.episodes) {
    episodeRows.push([ep.student, sess.sessionId, ep.episode, ep.mode || '—', ep.detected ? 'yes' : 'MISSED', ep.nudged ? 'yes' : 'no', ep.firstEdit === null ? 'never returned' : fmt(ep.firstEdit / 1000)]);
  }
}
const sessionRows = [['Student', 'Session', 'Duration', 'Labelled drifts', 'False nudges', 'False nudges / h', 'UNCERTAIN %', 'Corrections logged', 'Recording']];
for (const sess of evaluated) {
  sessionRows.push([sess.student, sess.sessionId, `${Math.round(sess.duration / 1000)}s`, sess.episodes.length, sess.falseNudges, fmt(sess.falseNudgesPerHour, 2), fmt(sess.uncertainPct), sess.corrections, sess.incomplete ? 'INCOMPLETE' : 'complete']);
}

const allEpisodes = evaluated.flatMap((sess) => sess.episodes);
const summary = [
  `Students: ${new Set(evaluated.map((sess) => sess.student)).size} · Sessions: ${evaluated.length} · Labelled drift episodes: ${allEpisodes.length}`,
  `Missed drifts: ${allEpisodes.filter((ep) => !ep.detected).length}/${allEpisodes.length}`,
  `Never returned (no first edit inside the episode): ${allEpisodes.filter((ep) => ep.firstEdit === null).length}`,
  `False nudges (matched to no labelled episode): ${evaluated.reduce((sum, sess) => sum + sess.falseNudges, 0)}`,
  `Correction events logged: ${evaluated.reduce((sum, sess) => sum + sess.corrections, 0)} (effect on nudges needs a controlled replay; not claimed here)`,
  missing.length ? `Labelled sessions with no CSV: ${missing.join(', ')}` : '',
  unlabeled.length ? `Sessions with no labels (not scored): ${unlabeled.join(', ')}` : '',
  `Note: the app logs one first edit per session, so only one episode per session can show a return.`,
].filter(Boolean).join('\n');

const markdown = `### Per drift episode\n\n${table(episodeRows)}\n\n### Per session\n\n${table(sessionRows)}`;
console.log(markdown);
console.log(`\n${summary}`);
if (args.out) {
  writeFileSync(resolve(args.out), `${markdown}\n\n${summary}\n`);
  console.log(`\nWrote ${resolve(args.out)}`);
}
