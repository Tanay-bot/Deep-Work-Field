/// <reference types="vite/client" />
import { DEFAULT_THRESHOLDS, MODES, THRESHOLD_META, type Mode, type Thresholds } from '../../shared/src/config';
import type { Checkpoint, Correction, FaceCue, FocusState, SessionRecord, TraceEntry } from '../../shared/src/types';
import { buildTextFragmentUrl } from '../../shared/src/fragments';
import { verifyCheckpointAsync } from '../../shared/src/verify';
import { captureCheckpointFromElement, newId, pickAnchorElement } from '../../shared/src/checkpoint';
import { embedText } from '../../shared/src/embed';
import { matchScreen, type ScreenSample } from '../../shared/src/screen';
import { focusByHour } from '../../shared/src/planner';
import { correctionVote } from '../../shared/src/knn';
import { FocusEngine, type EngineDecision } from '../../shared/src/engine';
import './lib/fx';
import { Galaxy } from './lib/galaxy';
import { Voice } from './lib/voice';
import { FaceSensor } from './lib/face';
import { loadSemantic, scaleSemantic, semanticSimilarity, semanticStatus } from './lib/semantic';
import { StudyRecorder, studyCsv, downloadBlob } from './lib/study';
import {
  deleteItem,
  getAll,
  loadCorrections,
  saveCheckpoint,
  saveCorrection,
  saveSession,
  saveStudyRecord,
  saveTrace,
  loadTraces,
  type StudyRecord,
} from './lib/db';

type ChromeLike = { runtime?: { sendMessage?: (...args: any[]) => void; lastError?: { message?: string } } };

const STORAGE = {
  thresholds: 'dwf:thresholds',
  frozen: 'dwf:frozen',
  mode: 'dwf:mode',
  goal: 'dwf:goal',
  extensionId: 'dwf:extension-id',
};

const DEMO_GOAL = 'AP Chem unit 4 limiting reagent';
/** Pinned by the `key` in extension/manifest.json, so every unpacked install has this ID. */
export const EXTENSION_ID = 'ebcoijhkmohgagkgkaaafhjkffcjcchn';
const extensionId = (): string => localStorage.getItem(STORAGE.extensionId) || EXTENSION_ID;

function $(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch);
}

function fmtClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function loadThresholds(): Thresholds {
  try {
    const raw = localStorage.getItem(STORAGE.thresholds);
    return { ...DEFAULT_THRESHOLDS, ...(raw ? JSON.parse(raw) : {}) };
  } catch {
    return { ...DEFAULT_THRESHOLDS };
  }
}

function loadFrozen(): boolean {
  return localStorage.getItem(STORAGE.frozen) === '1';
}

function loadMode(): Mode {
  const stored = localStorage.getItem(STORAGE.mode);
  return stored === 'resume-only' || stored === 'screen-only' || stored === 'full' ? stored : 'full';
}

function modeName(mode: Mode): string {
  return MODES.find((m) => m.id === mode)?.name ?? mode;
}

function spokenCheckpoint(checkpoint: Checkpoint | null): string {
  if (!checkpoint) return 'You left off on problem 4b, limiting reagent.';
  const cleaned = checkpoint.anchor.replace(/\s+/g, ' ').trim();
  const spoken = cleaned.replace(/^([0-9]+[a-z]?)[.)]\s*/i, '$1, ').toLowerCase();
  return `You were on ${spoken}.`;
}

const state = {
  mode: loadMode(),
  goal: localStorage.getItem(STORAGE.goal) ?? DEMO_GOAL,
  thresholds: loadThresholds(),
  frozen: loadFrozen(),
  sessionId: null as string | null,
  sessionStartedAt: 0,
  session: null as SessionRecord | null,
  checkpoint: null as Checkpoint | null,
  corrections: [] as Correction[],
  trace: [] as TraceEntry[],
  selectedTrace: -1,
  engine: null as FocusEngine | null,
  worksheet: null as Window | null,
  scenarioTimer: 0,
  clockTimer: 0,
  scenarioStartedAt: 0,
  firstEditLogged: false,
  restored: false,
  lastResumeUrl: '',
  lastStudyCsv: '',
  nudgeText: '',
  study: new StudyRecorder(),
  studyRecords: [] as StudyRecord[],
  voice: new Voice(),
  galaxy: null as Galaxy | null,
  extensionConnected: false,
  livePort: null as { postMessage: (m: unknown) => void; disconnect: () => void; onMessage: any; onDisconnect: any } | null,
  liveFace: null as FaceCue | null,
  face: new FaceSensor(),
  faceTimer: 0,
  calibrating: false,
  lastStateLog: '' as FocusState | '',
};

const dom = {
  galaxyCanvas: $('galaxy') as HTMLCanvasElement,
  landing: $('landing'),
  session: $('session'),
  modeSelect: $('mode-select') as HTMLSelectElement,
  extensionStatus: $('extension-status'),
  liveBtn: $('live-btn') as HTMLButtonElement,
  facePill: $('face-pill'),
  faceStatus: $('face-status'),
  facePreview: $('face-preview'),
  faceStart: $('face-start') as HTMLButtonElement,
  faceCalibrate: $('face-calibrate') as HTMLButtonElement,
  faceStop: $('face-stop') as HTMLButtonElement,
  liveStatus: $('live-status'),
  sessionGoal: $('session-goal'),
  statePill: $('state-pill'),
  modePill: $('mode-pill'),
  freezePill: $('freeze-pill'),
  sessionTimer: $('session-timer'),
  nudge: $('nudge'),
  nudgeText: $('nudge-text'),
  resumeNudge: $('resume-nudge') as HTMLButtonElement,
  nudgeDismiss: $('nudge-dismiss'),
  checkpointAge: $('checkpoint-age'),
  checkpointEmpty: $('checkpoint-empty'),
  checkpointBody: $('checkpoint-body'),
  cpProblem: $('cp-problem'),
  cpTitle: $('cp-title'),
  cpAnchor: $('cp-anchor'),
  cpContext: $('cp-context'),
  resumeBtn: $('resume-btn') as HTMLButtonElement,
  resumeCopy: $('resume-copy'),
  verifyStatus: $('verify-status'),
  firstEditStatus: $('first-edit-status'),
  driftStage: $('drift-stage'),
  demoStep: $('demo-step'),
  stepOpen: $('step-open') as HTMLButtonElement,
  stepDrift: $('step-drift') as HTMLButtonElement,
  traceList: $('trace-list'),
  traceCount: $('trace-count'),
  replayRange: $('replay-range') as HTMLInputElement,
  replayMarks: $('replay-marks'),
  replayLabel: $('replay-label'),
  replayDetail: $('replay-detail'),
  correctionStatus: $('correction-status'),
  neighborCount: $('neighbor-count'),
  correctionDetail: $('correction-detail'),
  voteOnTask: $('vote-ontask'),
  voteDrift: $('vote-drift'),
  correctOnTask: $('correct-on-task') as HTMLButtonElement,
  correctDrift: $('correct-drift') as HTMLButtonElement,
  correctFive: $('correct-five') as HTMLButtonElement,
  rerun: $('rerun-btn') as HTMLButtonElement,
  splitTest: $('split-test-btn') as HTMLButtonElement,
  clearCorrections: $('clear-corrections') as HTMLButtonElement,
  studyStatus: $('study-status'),
  studyStart: $('study-start') as HTMLButtonElement,
  studyStop: $('study-stop') as HTMLButtonElement,
  studyExport: $('study-export-last') as HTMLButtonElement,
  studyList: $('study-list'),
  galaxyBackend: $('galaxy-backend'),
  galaxyState: $('galaxy-state'),
  pipBtn: $('pip-btn') as HTMLButtonElement,
  miniPanel: $('mini-panel'),
  voiceBackend: $('voice-backend'),
  voiceStatus: $('voice-status'),
  voiceBar: $('voice-bar-fill'),
  settingsDialog: $('settings-dialog') as HTMLDialogElement,
  settingsBtn: $('settings-btn'),
  freezeToggle: $('freeze-toggle') as HTMLInputElement,
  thresholdFields: $('threshold-fields'),
  settingsSave: $('settings-save') as HTMLButtonElement,
  settingsReset: $('settings-reset') as HTMLButtonElement,
  goalInput: $('goal-input') as HTMLInputElement,
  unsupportedDialog: $('unsupported-dialog') as HTMLDialogElement,
  unsupportedBody: $('unsupported-body'),
  unsupportedUrl: $('unsupported-url'),
  unsupportedExt: $('unsupported-ext') as HTMLButtonElement,
  savedDialog: $('saved-dialog') as HTMLDialogElement,
  savedReason: $('saved-reason'),
  savedAnchor: $('saved-anchor'),
  savedContext: $('saved-context'),
  savedFrameWrap: $('saved-frame-wrap'),
  savedFrame: $('saved-frame') as HTMLImageElement,
  savedOpen: $('saved-open') as HTMLAnchorElement,
  savedRetry: $('saved-retry') as HTMLButtonElement,
  extensionDialog: $('extension-dialog') as HTMLDialogElement,
  extId: $('ext-id') as HTMLInputElement,
  extCheck: $('ext-check') as HTMLButtonElement,
  extResult: $('ext-result'),
  toast: $('toast'),
};

let toastTimer = 0;

function toast(message: string, kind: 'info' | 'ok' | 'warn' = 'info'): void {
  dom.toast.textContent = message;
  dom.toast.dataset.kind = kind;
  dom.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => dom.toast.classList.remove('show'), 4200);
}

function openDialog(dialog: HTMLDialogElement): void {
  if (!dialog.open) dialog.showModal();
}

function mountGalaxy(): void {
  Galaxy.create(dom.galaxyCanvas)
    .then((galaxy) => {
      state.galaxy = galaxy;
      dom.galaxyBackend.textContent = galaxy.backend === 'webgpu' ? 'WebGPU' : 'WebGL2';
      galaxy.setState('FOCUSED');
    })
    .catch(() => {
      dom.galaxyBackend.textContent = 'unavailable';
      dom.galaxyCanvas.style.display = 'none';
    });
}

function setupVoice(): void {
  void state.voice.preload((fraction, label) => {
    dom.voiceStatus.textContent = label;
    dom.voiceBar.style.width = `${Math.round(fraction * 100)}%`;
    dom.voiceBackend.textContent = state.voice.backend === 'device' ? 'device speech' : state.voice.backend;
  });
  window.speechSynthesis?.addEventListener?.('voiceschanged', () => {
    if (state.voice.ready) dom.voiceBackend.textContent = 'device speech';
  });
}

function applyState(focusState: FocusState): void {
  dom.statePill.textContent = focusState;
  dom.statePill.dataset.state = focusState;
  dom.galaxyState.textContent = focusState;
  dom.galaxyState.dataset.state = focusState;
  dom.miniPanel.dataset.state = focusState;
  state.galaxy?.setState(focusState);
  if (state.lastStateLog !== focusState) {
    state.lastStateLog = focusState;
    state.study.log('state', focusState, focusState);
  }
}

function renderCheckpoint(): void {
  const cp = state.checkpoint;
  dom.checkpointEmpty.hidden = !!cp;
  dom.checkpointBody.hidden = !cp;
  if (!cp) {
    dom.checkpointAge.textContent = 'none saved';
    return;
  }
  dom.checkpointAge.textContent = `${Math.max(0, Math.round((Date.now() - cp.createdAt) / 1000))}s ago`;
  dom.cpProblem.textContent = `Problem ${cp.problemId}`;
  dom.cpTitle.textContent = `${cp.title} · ${new URL(cp.url).pathname}`;
  dom.cpAnchor.textContent = `“${cp.anchor}”`;
  dom.cpContext.innerHTML = `… ${escapeHtml(cp.prefix)} <mark>${escapeHtml(cp.anchor)}</mark> ${escapeHtml(cp.suffix)} …`;
  dom.stepDrift.disabled = false;
}

function renderTrace(): void {
  dom.traceCount.textContent = `${state.trace.length} ${state.trace.length === 1 ? 'entry' : 'entries'}`;
  if (!state.trace.length) {
    dom.traceList.innerHTML = '<li class="empty">Every decision will appear here with its inputs and vote counts.</li>';
    dom.replayRange.max = '0';
    dom.replayRange.value = '0';
    return;
  }
  const start = Math.max(0, state.trace.length - 14);
  const rows: string[] = [];
  for (let i = state.trace.length - 1; i >= start; i--) {
    const entry = state.trace[i];
    const offset = ((entry.t - state.sessionStartedAt) / 1000).toFixed(1);
    const votes = entry.votes;
    const correction = entry.correction?.neighbors ? ` · corr ${entry.correction.onTask}–${entry.correction.drift}` : '';
    rows.push(
      `<li><button class="trace-row" type="button" data-index="${i}" ${state.selectedTrace === i ? 'aria-current="true"' : ''}>` +
        `<span class="trace-time">+${offset}s</span>` +
        `<span class="trace-state" data-state="${entry.state}">${entry.state}</span>` +
        `<span class="trace-reason">${escapeHtml(entry.reasons[0] ?? '')}${escapeHtml(correction)}</span>` +
        `<span class="trace-votes">v ${votes.drift}/${votes.onTask}/${votes.uncertain}${entry.nudge ? ' · nudge' : ''}</span>` +
        `</button></li>`,
    );
  }
  dom.traceList.innerHTML = rows.join('');
  dom.replayRange.max = String(state.trace.length - 1);
  if (state.selectedTrace < 0) {
    state.selectedTrace = state.trace.length - 1;
    dom.replayRange.value = String(state.selectedTrace);
  }
  renderReplayMarks();
}

function renderReplayMarks(): void {
  const total = Math.max(1, state.trace.length);
  const marks: string[] = [];
  state.trace.forEach((entry, index) => {
    const left = (index / total) * 100;
    if (entry.distractionLogged) marks.push(`<i class="mark-drift" style="left:${left}%" title="Distraction logged"></i>`);
    if (entry.nudge) marks.push(`<i class="mark-nudge" style="left:${left}%" title="Nudge"></i>`);
  });
  dom.replayMarks.innerHTML = marks.join('');
}

function renderReplayDetail(index: number): void {
  const entry = state.trace[index];
  if (!entry) return;
  state.selectedTrace = index;
  dom.replayRange.value = String(index);
  const offset = ((entry.t - state.sessionStartedAt) / 1000).toFixed(1);
  dom.replayLabel.textContent = `+${offset}s · ${entry.state}`;
  const votes = entry.votes;
  const correction = entry.correction
    ? `<div class="kv">corrections ${entry.correction.onTask} on-task / ${entry.correction.drift} drift of ${entry.correction.neighbors} · decision ${entry.correction.decision}</div>`
    : '';
  const face = entry.inputs.face
    ? `face present=${entry.inputs.face.present} headDown=${entry.inputs.face.headDown}${entry.inputs.face.pitchDeg !== undefined ? ` pitch=${entry.inputs.face.pitchDeg}°` : ''}`
    : 'face unavailable';
  dom.replayDetail.innerHTML =
    `<strong>${entry.state}</strong> · votes drift ${votes.drift} / on-task ${votes.onTask} / uncertain ${votes.uncertain}` +
    `<div class="kv">sim ${entry.inputs.onTaskSimilarity.toFixed(2)} · smoothed ${entry.inputs.smoothedSimilarity.toFixed(2)} · ${entry.inputs.mode} · ${entry.inputs.source} · ${escapeHtml(face)}</div>` +
    correction +
    `<ul>${entry.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join('')}</ul>`;
  applyState(entry.state);
  updateCorrectionPanel(entry);
  dom.replayRange.value = String(index);
  renderTraceSelection();
}

function renderTraceSelection(): void {
  dom.traceList.querySelectorAll<HTMLButtonElement>('.trace-row').forEach((button) => {
    const index = Number(button.dataset.index);
    if (index === state.selectedTrace) button.setAttribute('aria-current', 'true');
    else button.removeAttribute('aria-current');
  });
}

function currentEntry(): TraceEntry | undefined {
  return state.trace[state.selectedTrace] ?? state.trace[state.trace.length - 1];
}

function updateCorrectionPanel(entry?: TraceEntry): void {
  const target = entry ?? currentEntry();
  if (!target) {
    dom.neighborCount.textContent = `0 / ${state.thresholds.correctionK}`;
    dom.voteOnTask.style.width = '0%';
    dom.voteDrift.style.width = '0%';
    dom.correctionDetail.textContent = 'Stored locally per goal. Override needs 5 neighbours and a 4-of-5 vote.';
    return;
  }
  const vote = correctionVote(
    state.corrections,
    embedText(target.inputs.screenText),
    state.goal,
    state.thresholds.correctionK,
    state.thresholds.correctionMaxDistance,
    state.thresholds.correctionSupermajority,
  );
  dom.neighborCount.textContent = `${vote.neighbors} / ${state.thresholds.correctionK}`;
  const total = Math.max(0.0001, vote.weightedOnTask + vote.weightedDrift);
  dom.voteOnTask.style.width = `${Math.round((vote.weightedOnTask / total) * 100)}%`;
  dom.voteDrift.style.width = `${Math.round((vote.weightedDrift / total) * 100)}%`;
  dom.correctionDetail.innerHTML =
    `Nearby: <strong>${vote.onTask}</strong> on-task · <strong>${vote.drift}</strong> drift · decision <strong>${vote.decision}</strong>. ` +
    `Override requires ${state.thresholds.correctionSupermajority}-of-${state.thresholds.correctionK} within distance ${state.thresholds.correctionMaxDistance}.`;
  dom.correctionStatus.textContent =
    vote.neighbors === 0
      ? `No corrections stored for “${state.goal}” yet.`
      : `${state.corrections.filter((c) => c.goal === state.goal).length} corrections stored for this goal.`;
}

function appendDecision(decision: EngineDecision, input: { screenText: string; sim: number; face: FaceCue | null; source: 'dom' | 'ocr' | 'scripted' | 'none' }, extraReason?: string): TraceEntry {
  const entry: TraceEntry = {
    id: newId('trace'),
    sessionId: state.sessionId ?? 'sess_local',
    t: Date.now(),
    state: decision.state,
    inputs: {
      mode: state.mode,
      screenText: input.screenText,
      onTaskSimilarity: input.sim,
      smoothedSimilarity: decision.smoothedSimilarity,
      face: input.face,
      source: input.source,
    },
    votes: decision.votes,
    reasons: extraReason ? [...decision.reasons, extraReason] : decision.reasons,
    distractionLogged: decision.distractionLogged,
    nudge: decision.nudge,
    correction: decision.correction ?? undefined,
  };
  state.trace.push(entry);
  state.selectedTrace = state.trace.length - 1;
  // Persist live sessions as they run (not only on pagehide) so a crash keeps them.
  if (input.source !== 'scripted' && state.trace.length % 20 === 0) void saveTrace(state.trace).then(renderPlanner).catch(() => undefined);
  applyState(decision.state);
  if (decision.distractionLogged) state.study.log('drift', `sim=${input.sim.toFixed(2)}`, decision.state);
  if (decision.nudge) {
    state.study.log('nudge', state.nudgeText, decision.state);
    state.voice.speak(state.nudgeText);
    showNudge();
  }
  renderTrace();
  renderReplayDetail(state.selectedTrace);
  return entry;
}

function showNudge(): void {
  state.nudgeText = spokenCheckpoint(state.checkpoint);
  dom.nudgeText.textContent = state.nudgeText;
  dom.nudge.hidden = false;
}

function scenarioSignal(elapsed: number): { text: string; sim: number; face: FaceCue } {
  if (elapsed < 4200) {
    return {
      text:
        'AP Chem unit 4 limiting reagent stoichiometry lecture notes. ' +
        'Compare moles of aluminum and chlorine, use the 2 to 3 mole ratio, then calculate the theoretical yield of aluminum chloride.',
      sim: 0.74,
      face: { present: true, headDown: false, eyesClosed: false, pitchDeg: 2 },
    };
  }
  if (elapsed < 6800) {
    return {
      text:
        'AP Chem unit 4 limiting reagent worksheet problem 4b. Show the mole ratio and the theoretical yield of aluminum chloride. ' +
        'Writing the calculation on paper.',
      sim: 0.76,
      face: { present: true, headDown: true, eyesClosed: false, pitchDeg: 29 },
    };
  }
  return {
    text: 'Minecraft parkour gameplay compilation funny moments no commentary best jumps 2026',
    sim: 0.11,
    face: { present: true, headDown: false, eyesClosed: false, pitchDeg: -4 },
  };
}

function scenarioTick(): void {
  if (!state.engine || !state.sessionId) return;
  const elapsed = Date.now() - state.scenarioStartedAt;
  const signal = scenarioSignal(elapsed);
  state.nudgeText = spokenCheckpoint(state.checkpoint);
  const decision = state.engine.update({
    t: Date.now(),
    screenText: signal.text,
    onTaskSimilarity: signal.sim,
    embedding: embedText(signal.text),
    face: signal.face,
    source: 'scripted',
  });
  appendDecision(decision, { screenText: signal.text, sim: signal.sim, face: signal.face, source: 'scripted' });
}

function startScenario(): void {
  if (!state.engine) return;
  stopScenario();
  stopLive(true);
  try {
    state.worksheet?.close();
  } catch {
    /* already closed */
  }
  state.worksheet = null;
  state.scenarioStartedAt = Date.now();
  state.engine.resetRun(Date.now());
  state.trace = [];
  state.selectedTrace = -1;
  state.firstEditLogged = false;
  state.restored = false;
  state.lastStateLog = '';
  state.study.log('mode', state.mode);
  dom.driftStage.hidden = false;
  dom.nudge.hidden = true;
  dom.firstEditStatus.hidden = true;
  dom.verifyStatus.hidden = true;
  dom.demoStep.textContent = 'Simulated drift running: on-task lecture, then writing, then a distraction. The nudge waits for the 3-second hold.';
  dom.stepDrift.disabled = true;
  renderTrace();
  state.scenarioTimer = window.setInterval(scenarioTick, state.thresholds.sessionTickMs);
  scenarioTick();
}

function stopScenario(): void {
  if (state.scenarioTimer) {
    clearInterval(state.scenarioTimer);
    state.scenarioTimer = 0;
  }
  dom.driftStage.hidden = true;
}

/* ---------- Live mode: the real active tab, via the extension ------------- */
function startLive(): void {
  const chromeApi = (globalThis as unknown as { chrome?: any }).chrome;
  if (!state.engine || !state.extensionConnected || !chromeApi?.runtime?.connect) {
    toast('Live mode needs the Chrome extension. Use “Get the extension”.', 'warn');
    return;
  }
  stopScenario();
  stopLive(true);
  let port: any;
  try {
    port = chromeApi.runtime.connect(extensionId(), { name: 'dwf-screen' });
  } catch {
    toast('Could not open the live connection to the extension.', 'warn');
    return;
  }
  state.livePort = port;
  state.engine.resetRun(Date.now());
  state.trace = [];
  state.selectedTrace = -1;
  state.lastStateLog = '';
  state.study.log('mode', `${state.mode}; live`);
  dom.nudge.hidden = true;
  port.onMessage.addListener((message: ScreenSample & { type: string }) => {
    if (message?.type === 'screen') void liveSample(message);
  });
  port.onDisconnect.addListener(() => {
    if (state.livePort === port) stopLive(false, 'The extension disconnected (it may have been reloaded or disabled).');
  });
  dom.liveBtn.textContent = 'Stop live';
  dom.stepDrift.disabled = true;
  dom.demoStep.textContent =
    state.mode === 'full' && !state.face.running
      ? 'Live: reading your active tab. Full fusion also needs face cues: turn on the camera in “Face cues”, or switch Mode to Screen-only.'
      : 'Live: reading your active tab through the extension. Switch to another tab to see the field react; come back to the worksheet to recover.';
  dom.liveStatus.textContent = 'Live · waiting for the first sample from your active tab…';
  renderTrace();
  void loadSemantic((label) => (dom.liveStatus.textContent = `Live · ${label}`)).catch(() => {
    dom.liveStatus.textContent = 'Live · the semantic matcher could not load here; using goal-term coverage only.';
  });
}

let liveBusy = false;

function stopLive(silent = false, reason = ''): void {
  const port = state.livePort;
  state.livePort = null;
  try {
    port?.disconnect();
  } catch {
    /* already closed */
  }
  dom.liveBtn.textContent = 'Use my real screen';
  dom.stepDrift.disabled = !state.checkpoint;
  if (!silent && port) {
    dom.liveStatus.textContent = reason || 'Live mode stopped.';
    if (reason) toast(reason, 'warn');
  }
}

async function liveSample(sample: ScreenSample): Promise<void> {
  if (!state.engine || !state.sessionId || liveBusy) return;
  let host = '';
  try {
    const url = new URL(sample.url);
    host = url.hostname || url.protocol.replace(':', '');
    if (url.origin === location.origin && !url.pathname.startsWith('/demo/')) {
      dom.liveStatus.textContent = 'Live · you are looking at Deep Work Field itself; not scored.';
      return;
    }
  } catch {
    host = 'unknown page';
  }
  liveBusy = true;
  try {
    const match = matchScreen(state.goal, sample, state.checkpoint);
    let sim = match.sim;
    let reason = match.reason;
    if (semanticStatus === 'ready') {
      // Semantic evidence can only raise on-task similarity (near-topic pages).
      const cosine = await semanticSimilarity(state.goal, `${sample.title}. ${sample.text}`.slice(0, 1200));
      const scaled = scaleSemantic(cosine);
      reason += `; meaning match ${cosine.toFixed(2)} (MiniLM)`;
      if (scaled > sim) sim = Number(scaled.toFixed(3));
    }
    if (!state.engine || !state.sessionId || !state.livePort) return;
    if (state.face.running) state.liveFace = state.face.sample(state.thresholds.headDownPitchDeg);
    const screenText = `${sample.title}${sample.text ? ' — ' + sample.text.slice(0, 240) : ''}`;
    const face = state.liveFace;
    state.nudgeText = spokenCheckpoint(state.checkpoint);
    const decision = state.engine.update({
      t: Date.now(),
      screenText,
      onTaskSimilarity: sim,
      embedding: embedText(`${sample.title} ${sample.text}`),
      face,
      source: 'dom',
    });
    appendDecision(decision, { screenText, sim, face, source: 'dom' }, `Live tab ${host}: ${reason}.`);
    dom.liveStatus.textContent = `Live · ${host} · ${reason} · ${decision.state}`;
  } catch {
    /* a failed semantic call must not stop the stream; next sample retries */
  } finally {
    liveBusy = false;
  }
}

function beginSession(): void {
  if (state.sessionId) return;
  state.sessionId = newId('sess');
  state.sessionStartedAt = Date.now();
  state.session = {
    id: state.sessionId,
    goal: state.goal,
    mode: state.mode,
    startedAt: state.sessionStartedAt,
    thresholdsFrozen: state.frozen,
  };
  state.trace = [];
  state.selectedTrace = -1;
  state.firstEditLogged = false;
  state.restored = false;
  state.lastStateLog = '';
  state.engine = new FocusEngine({
    mode: state.mode,
    goal: state.goal,
    thresholds: state.thresholds,
    corrections: state.corrections,
  });
  state.engine.resetRun(state.sessionStartedAt);
  void saveSession(state.session);
  void loadCorrections(state.goal).then((list) => {
    state.corrections = list;
    state.engine?.updateOptions({ corrections: list });
    updateCorrectionPanel();
  });
  dom.sessionGoal.textContent = state.goal;
  dom.modePill.textContent = modeName(state.mode);
  dom.freezePill.hidden = !state.frozen;
  dom.nudge.hidden = true;
  dom.verifyStatus.hidden = true;
  dom.firstEditStatus.hidden = true;
  dom.checkpointAge.textContent = 'none saved';
  dom.studyStatus.textContent = 'idle';
  renderCheckpoint();
  renderTrace();
  clearInterval(state.clockTimer);
  state.clockTimer = window.setInterval(() => {
    dom.sessionTimer.textContent = fmtClock(Date.now() - state.sessionStartedAt);
  }, 1000);
  dom.sessionTimer.textContent = '00:00';
  state.study.log('session-start', `mode=${state.mode}; goal=${state.goal}`);
  state.study.setMode(state.mode);
}

function showSession(): void {
  dom.landing.hidden = true;
  dom.session.hidden = false;
  window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
  document.title = `Session · ${state.goal} — Deep Work Field`;
}

async function waitForWindow(win: Window, timeout = 7000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      if (win.closed) return false;
      const doc = win.document;
      if (
        doc &&
        doc.readyState === 'complete' &&
        doc.body &&
        doc.URL &&
        !doc.URL.startsWith('about:') &&
        (doc.body.innerText ?? '').trim().length > 20
      ) {
        return true;
      }
    } catch {
      /* navigation in progress */
    }
    await sleep(120);
  }
  return false;
}

function closeWorksheet(): void {
  try {
    state.worksheet?.close();
  } catch {
    /* ignore */
  }
  state.worksheet = null;
}

async function captureFromWindow(win: Window): Promise<Checkpoint | null> {
  if (!(await waitForWindow(win))) return null;
  let heading: Element | null = null;
  try {
    const api = (win as unknown as { DWF_CAPTURE?: (id: string) => { heading?: Element } | null }).DWF_CAPTURE;
    heading = api?.('4b')?.heading ?? null;
  } catch {
    heading = null;
  }
  if (!heading) {
    try {
      heading = win.document.querySelector('[data-problem-id="4b"] h3, [data-problem-id="4b"] [data-anchor-text]');
    } catch {
      heading = null;
    }
  }
  if (!heading) return null;
  return captureCheckpointFromElement(win.document, heading, { goal: state.goal, problemId: '4b' });
}

function prepareWorksheet(win: Window): void {
  void captureFromWindow(win).then((checkpoint) => {
    if (!checkpoint) {
      toast('Could not capture problem 4b. Allow popups, reopen the worksheet, and try again.', 'warn');
      dom.stepOpen.disabled = false;
      return;
    }
    state.checkpoint = checkpoint;
    state.lastResumeUrl = buildTextFragmentUrl(checkpoint.url, checkpoint);
    void saveCheckpoint(checkpoint);
    renderCheckpoint();
    dom.stepDrift.disabled = false;
    dom.demoStep.textContent =
      `Checkpoint saved: “${checkpoint.anchor}” with ${checkpoint.prefix.length} prefix / ${checkpoint.suffix.length} suffix characters. Close the tab and simulate drift.`;
    toast('Checkpoint saved for problem 4b.', 'ok');
    dom.verifyStatus.hidden = true;
  });
}

function openDemoWorksheet(): Window | null {
  const win = window.open('/demo/worksheet-a.html', 'dwf-worksheet');
  if (!win) {
    toast('Allow popups for this site to open the demo worksheet.', 'warn');
    return null;
  }
  state.worksheet = win;
  dom.demoStep.textContent = 'Saving problem 4b from the worksheet…';
  prepareWorksheet(win);
  return win;
}

async function tryItNow(): Promise<void> {
  beginSession();
  showSession();
  openDemoWorksheet();
}

async function resume(): Promise<void> {
  const checkpoint = state.checkpoint;
  if (!checkpoint) {
    toast('Save a checkpoint first.', 'warn');
    return;
  }
  stopScenario();
  dom.nudge.hidden = true;
  state.restored = false;
  const url = buildTextFragmentUrl(checkpoint.url, checkpoint);
  state.lastResumeUrl = url;
  const win = window.open(url, 'dwf-resume');
  if (!win) {
    toast('Allow popups, then click Resume again.', 'warn');
    return;
  }
  closeWorksheet();
  state.worksheet = win;
  dom.verifyStatus.hidden = false;
  dom.verifyStatus.dataset.kind = 'pending';
  dom.verifyStatus.innerHTML = '<strong>Opening the fragment and checking the passage…</strong><span class="mono">Waiting for the page and Chrome\'s scroll-to-text navigation.</span>';
  const loaded = await waitForWindow(win);
  if (!loaded) {
    dom.verifyStatus.dataset.kind = 'fail';
    dom.verifyStatus.textContent = 'The page did not load, so there is nothing to verify.';
    showSavedContext(checkpoint, 'unreadable');
    return;
  }
  const result = await verifyCheckpointAsync(win.document, checkpoint, {
    attempts: state.thresholds.verifyAttempts,
    retryMs: state.thresholds.verifyRetryMs,
    scrollAfter: state.thresholds.verifyScrollAfter,
  });
  if (!result.ok) {
    dom.verifyStatus.dataset.kind = 'fail';
    let childState = '';
    try {
      childState = `doc=${win.document.URL.slice(0, 90)} ready=${win.document.readyState} text=${(win.document.body?.innerText ?? '').length}`;
    } catch {
      childState = 'child document was unreadable';
    }
    dom.verifyStatus.innerHTML =
      `<strong>Restore not verified.</strong> ${escapeHtml(result.reason)} · ${result.candidates} candidate(s) · ${result.attempts} attempt(s).` +
      `<span class="mono">${escapeHtml(childState)} · showing saved context instead of claiming a resume.</span>`;
    state.study.log('restore-failed', result.reason);
    showSavedContext(checkpoint, result.reason);
    return;
  }
  state.restored = true;
  dom.verifyStatus.dataset.kind = 'ok';
  dom.verifyStatus.innerHTML =
    `<strong>Verified restore.</strong> ${escapeHtml(landingNote(win, checkpoint))} ` +
    `Exactly one of ${result.candidates} “${escapeHtml(checkpoint.anchor)}” occurrence(s) matched the surrounding text, and it is in view ` +
    `(${result.landing === 'dom-scroll' ? 'landed by one app scroll; the browser fragment did not land it' : 'landed by the browser'}).` +
    `<span class="mono">prefix “${escapeHtml(checkpoint.prefix)}” · suffix “${escapeHtml(checkpoint.suffix)}”</span>`;
  dom.checkpointAge.textContent = 'restored just now';
  dom.firstEditStatus.hidden = true;
  dom.firstEditStatus.textContent = '';
  state.study.log('resume', `${landingNote(win, checkpoint)} · attempts=${result.attempts}`, 'FOCUSED');
  try {
    const mark = (win as unknown as { DWF_VERIFIED?: (label: string, id: string) => void }).DWF_VERIFIED;
    mark?.(`Verified · problem ${checkpoint.problemId}`, checkpoint.problemId);
  } catch {
    /* page closed */
  }
  try {
    const api = (win as unknown as { DWF_FOCUS_ANSWER?: (id: string) => boolean }).DWF_FOCUS_ANSWER;
    api?.(checkpoint.problemId);
    if (!api) {
      const host = checkpoint.selectorHint ? win.document.querySelector(checkpoint.selectorHint) : null;
      const field = (host ?? win.document).querySelector('textarea,input') as HTMLElement | null;
      field?.focus();
      host?.scrollIntoView({ block: 'center' });
    }
  } catch {
    /* page closed */
  }
  attachEditTracking(win, checkpoint, result.range);
  stopScenario();
  dom.stepDrift.disabled = false;
  dom.demoStep.textContent =
    'Verified restore complete. Edit the answer to record the first qualifying edit; the checkpoint is still saved if you want to replay the drift.';
  applyState('FOCUSED');
  toast('Verified: back at problem 4b.', 'ok');
}

function landingNote(win: Window, checkpoint: Checkpoint): string {
  try {
    const host = checkpoint.selectorHint ? win.document.querySelector(checkpoint.selectorHint) : null;
    if (host) {
      const rect = host.getBoundingClientRect();
      const visible = rect.height > 0 && rect.bottom > 0 && rect.top < win.innerHeight;
      if (visible) {
        const role = host.getAttribute('data-role');
        if (role === 'problem') return 'Landed on the Part II problem 4b, not the answer key.';
        if (role === 'key') return 'Landed on the answer-key copy — verification should have rejected this.';
        return `Landed on problem ${checkpoint.problemId}.`;
      }
    }
  } catch {
    /* cross-origin */
  }
  return 'Matched the saved prefix/suffix with the passage in view.';
}

let detachEditTracking: (() => void) | null = null;

/**
 * Scoped to the passage that was actually verified: the answer field must sit
 * inside the same problem container as the verified range. If none can be
 * linked with confidence, the first-edit metric is left unavailable rather
 * than guessed. Progress is measured from the field's value at restore time,
 * so a prefilled answer cannot qualify on a single keystroke.
 */
function attachEditTracking(win: Window, checkpoint: Checkpoint, verified?: Range): void {
  detachEditTracking?.();
  detachEditTracking = null;
  try {
    const doc = win.document;
    const origin = verified?.startContainer.parentElement ?? null;
    const host =
      (origin?.closest('[data-answer-region],[data-problem-id]') as Element | null) ??
      (checkpoint.selectorHint ? doc.querySelector(checkpoint.selectorHint) : null);
    const field = host?.querySelector('textarea,input') as HTMLInputElement | HTMLTextAreaElement | null;
    if (!field) {
      dom.firstEditStatus.hidden = false;
      dom.firstEditStatus.textContent = 'No answer field is linked to the verified passage, so first-edit timing is unavailable here.';
      return;
    }
    const baseline = field.value;
    const handler = () => {
      const value = field.value;
      const added = Math.max(0, value.length - baseline.length);
      const newline = (value.match(/\n/g)?.length ?? 0) > (baseline.match(/\n/g)?.length ?? 0);
      onAnswerInput(added, newline);
    };
    field.addEventListener('input', handler);
    detachEditTracking = () => field.removeEventListener('input', handler);
  } catch {
    /* closed or cross-origin */
  }
}

function onAnswerInput(chars: number, newline: boolean): void {
  if (!state.restored || !state.sessionId) return;
  const qualifies = chars >= state.thresholds.minQualifyingChars || newline;
  dom.firstEditStatus.hidden = false;
  if (state.firstEditLogged) {
    dom.firstEditStatus.textContent = `Answer edit in progress · ${chars} new chars · first qualifying edit already recorded.`;
    return;
  }
  if (!qualifies) {
    dom.firstEditStatus.textContent = `Answer region: ${chars}/${state.thresholds.minQualifyingChars} new characters before this counts as the first qualifying edit.`;
    return;
  }
  state.firstEditLogged = true;
  dom.firstEditStatus.textContent = `First qualifying edit recorded at problem ${state.checkpoint?.problemId ?? '4b'} (${chars} new chars${newline ? ', newline' : ''}).`;
  state.study.log('first-edit', `chars=${chars}; newline=${newline}`, 'WRITING');
  toast('First qualifying edit recorded.', 'ok');
}

function showSavedContext(checkpoint: Checkpoint, reason: string): void {
  const reasons: Record<string, string> = {
    'no-match': 'The saved anchor text was not found on the page.',
    'context-mismatch': 'The anchor was found, but the text immediately before or after it did not match the checkpoint.',
    'not-in-viewport': 'The passage matched, but it never landed inside the viewport.',
    unreadable: 'The page could not be read, or it was closed while checking.',
    ambiguous: 'Multiple matching passages: more than one place on the page has the same text before and after it, so the app will not pick one for you.',
    ok: 'The check did not complete.',
  };
  dom.savedReason.textContent = reasons[reason] ?? 'The restore could not be verified.';
  dom.savedAnchor.textContent = `“${checkpoint.anchor}”`;
  dom.savedContext.textContent = `… ${checkpoint.prefix} [${checkpoint.anchor}] ${checkpoint.suffix} …`;
  dom.savedOpen.href = checkpoint.url;
  if (checkpoint.savedFrame) {
    dom.savedFrame.src = checkpoint.savedFrame;
    dom.savedFrameWrap.hidden = false;
  } else {
    dom.savedFrame.removeAttribute('src');
    dom.savedFrameWrap.hidden = true;
  }
  openDialog(dom.savedDialog);
}

function renderThresholdFields(): void {
  dom.thresholdFields.innerHTML = (Object.keys(THRESHOLD_META) as (keyof Thresholds)[])
    .map((key) => {
      const meta = THRESHOLD_META[key];
      return (
        `<label class="threshold-field"><span>${escapeHtml(meta.label)}</span>` +
        `<input type="number" data-key="${key}" min="${meta.min}" max="${meta.max}" step="${meta.step}" value="${state.thresholds[key]}" ${state.frozen ? 'disabled' : ''} /></label>`
      );
    })
    .join('');
}

function setSettingsDisabled(disabled: boolean): void {
  dom.thresholdFields.querySelectorAll<HTMLInputElement>('input').forEach((input) => {
    input.disabled = disabled;
  });
  dom.settingsReset.disabled = disabled;
}

function openSettings(): void {
  dom.goalInput.value = state.goal;
  dom.freezeToggle.checked = state.frozen;
  renderThresholdFields();
  setSettingsDisabled(state.frozen);
  openDialog(dom.settingsDialog);
}

function saveSettings(event: Event): void {
  event.preventDefault();
  const goal = dom.goalInput.value.trim() || DEMO_GOAL;
  const frozen = dom.freezeToggle.checked;
  const next: Thresholds = { ...state.thresholds };
  if (!frozen) {
    dom.thresholdFields.querySelectorAll<HTMLInputElement>('input[data-key]').forEach((input) => {
      const key = input.dataset.key as keyof Thresholds;
      const value = Number(input.value);
      if (Number.isFinite(value)) next[key] = value;
    });
    if (next.onTaskSimilarity <= next.offTaskSimilarity) {
      toast('On-task similarity must be greater than off-task similarity.', 'warn');
      return;
    }
  }
  state.goal = goal;
  state.thresholds = next;
  state.frozen = frozen;
  localStorage.setItem(STORAGE.goal, goal);
  localStorage.setItem(STORAGE.thresholds, JSON.stringify(next));
  localStorage.setItem(STORAGE.frozen, frozen ? '1' : '0');
  if (state.session) {
    state.session.goal = goal;
    state.session.thresholdsFrozen = frozen;
    void saveSession(state.session);
  }
  state.engine?.updateOptions({ thresholds: next, goal });
  void loadCorrections(goal).then((list) => {
    state.corrections = list;
    state.engine?.updateOptions({ corrections: list });
    updateCorrectionPanel();
  });
  dom.sessionGoal.textContent = goal;
  dom.freezePill.hidden = !frozen;
  dom.modeSelect.value = state.mode;
  renderThresholdFields();
  dom.settingsDialog.close();
  toast(frozen ? 'Thresholds frozen for evaluation.' : 'Thresholds saved.', 'ok');
}

function resetThresholds(): void {
  if (state.frozen) {
    toast('Thresholds are frozen. Unfreeze to reset them.', 'warn');
    return;
  }
  state.thresholds = { ...DEFAULT_THRESHOLDS };
  renderThresholdFields();
  toast('Defaults restored in the form. Save to apply.');
}

function setMode(mode: Mode): void {
  state.mode = mode;
  dom.modeSelect.value = mode;
  dom.modePill.textContent = modeName(mode);
  localStorage.setItem(STORAGE.mode, mode);
  state.engine?.updateOptions({ mode });
  state.study.setMode(mode);
  if (state.session) {
    state.session.mode = mode;
    void saveSession(state.session);
  }
  if (mode === 'resume-only') {
    dom.nudge.hidden = true;
    stopScenario();
    applyState('FOCUSED');
    toast('Resume-only: detection and nudges are off; checkpoints and restore still work.');
  } else {
    toast(`${modeName(mode)} enabled.`);
  }
}

function formatCorrectionTargets(count: number, label: 'on-task' | 'drift'): Correction[] {
  const entry = currentEntry();
  if (!entry) return [];
  const embedding = embedText(entry.inputs.screenText);
  const driftEntries = state.trace.filter((candidate) => candidate.state === 'DRIFTING');
  const ordered = [entry, ...driftEntries.filter((candidate) => candidate.id !== entry.id)];
  const chosen: TraceEntry[] = [];
  const seen = new Set<string>();
  for (const candidate of ordered) {
    if (chosen.length >= count) break;
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    chosen.push(candidate);
  }
  return chosen.map((candidate) => ({
    id: newId('corr'),
    goal: state.goal,
    createdAt: Date.now(),
    label,
    embedding,
    excerpt: candidate.inputs.screenText.slice(0, 110),
    traceId: candidate.id,
  }));
}

async function storeCorrections(corrections: Correction[]): Promise<void> {
  if (!corrections.length) {
    toast('Select a drift moment in the replay first.', 'warn');
    return;
  }
  for (const correction of corrections) {
    await saveCorrection(correction);
    state.corrections.push(correction);
  }
  state.engine?.updateOptions({ corrections: state.corrections });
  updateCorrectionPanel();
  state.study.log('correction', `stored=${corrections.length}; label=${corrections[0]?.label ?? 'unknown'}`);
  toast(`${corrections.length} correction${corrections.length === 1 ? '' : 's'} stored locally for this goal.`, 'ok');
}

function correctSelected(label: 'on-task' | 'drift'): void {
  const targets = formatCorrectionTargets(1, label);
  void storeCorrections(targets);
}

function correctFive(): void {
  const targets = formatCorrectionTargets(5, 'on-task');
  void storeCorrections(targets);
}

function addSplitTest(): void {
  const entry = currentEntry();
  if (!entry) {
    toast('Select a trace entry first.', 'warn');
    return;
  }
  const embedding = embedText(entry.inputs.screenText);
  const labels: ('on-task' | 'drift')[] = ['on-task', 'on-task', 'on-task', 'drift', 'drift'];
  const corrections = labels.map((label, index) => ({
    id: newId('corr'),
    goal: state.goal,
    createdAt: Date.now() + index,
    label,
    embedding,
    excerpt: `${entry.inputs.screenText.slice(0, 80)} · split-test ${index + 1}`,
    traceId: `${entry.id}-split-${index}`,
  }));
  void storeCorrections(corrections).then(() => toast('3 on-task / 2 drift stored. Run a later similar moment to see UNCERTAIN.', 'ok'));
}

function rerunSimilar(): void {
  const entry = currentEntry();
  if (!entry || !state.engine) {
    toast('Select a trace entry to replay.', 'warn');
    return;
  }
  const decision = state.engine.update({
    t: Date.now(),
    screenText: entry.inputs.screenText,
    onTaskSimilarity: entry.inputs.onTaskSimilarity,
    embedding: embedText(entry.inputs.screenText),
    face: entry.inputs.face,
    source: 'scripted',
  });
  const added = appendDecision(decision, {
    screenText: entry.inputs.screenText,
    sim: entry.inputs.onTaskSimilarity,
    face: entry.inputs.face,
    source: 'scripted',
  }, 'Later similar moment re-run with the current correction memory.');
  const correction = added.correction;
  if (correction?.decision === 'on-task' || correction?.decision === 'drift') {
    state.study.log('correction', `decision=${correction.decision}; votes=${correction.onTask}-${correction.drift}`);
  }
  toast(
    correction?.decision === 'split'
      ? `Split ${correction.onTask}–${correction.drift}: UNCERTAIN, no nudge.`
      : `Decision ${added.state}${correction ? ` · corrections ${correction.onTask}/${correction.neighbors}` : ''}.`,
    added.state === 'DRIFTING' ? 'warn' : 'ok',
  );
}

async function clearCorrections(): Promise<void> {
  const mine = state.corrections.filter((correction) => correction.goal === state.goal);
  for (const correction of mine) await deleteItem('corrections', correction.id);
  state.corrections = state.corrections.filter((correction) => correction.goal !== state.goal);
  state.engine?.updateOptions({ corrections: state.corrections });
  updateCorrectionPanel();
  toast(`Cleared ${mine.length} correction${mine.length === 1 ? '' : 's'} for this goal.`);
}

function setupSettings(): void {
  renderThresholdFields();
  dom.settingsBtn.addEventListener('click', openSettings);
  dom.freezeToggle.addEventListener('change', () => setSettingsDisabled(dom.freezeToggle.checked));
  const form = document.getElementById('thresholds-form') as HTMLFormElement | null;
  form?.addEventListener('submit', (event) => {
    const submitter = (event as SubmitEvent).submitter as HTMLButtonElement | null;
    if (submitter?.id !== 'settings-save') return;
    saveSettings(event);
  });
  dom.settingsSave.addEventListener('click', () => {
    /* The form's submit handler owns saving; this keeps the button accessible
       when the form is submitted by keyboard. */
  });
  dom.settingsReset.addEventListener('click', resetThresholds);
  dom.modeSelect.addEventListener('change', () => setMode(dom.modeSelect.value as Mode));
}

function renderStudyList(): void {
  if (!state.studyRecords.length) {
    dom.studyList.innerHTML = '';
    return;
  }
  dom.studyList.innerHTML = state.studyRecords
    .slice(-5)
    .reverse()
    .map(
      (record, index) =>
        `<li><span class="grow">${new Date(record.startedAt).toLocaleTimeString()} · ${escapeHtml(record.mode)} · ${record.events.length} events · ${record.video ? 'video' : 'no video'}</span>` +
        `<button class="btn tiny ghost" type="button" data-csv="${record.id}">CSV</button>` +
        (record.video ? `<button class="btn tiny ghost" type="button" data-video="${record.id}">Video</button>` : '') +
        `</li>`,
    )
    .join('');
  dom.studyList.querySelectorAll<HTMLButtonElement>('[data-csv]').forEach((button) => {
    button.addEventListener('click', () => {
      const record = state.studyRecords.find((item) => item.id === button.dataset.csv);
      if (record) downloadBlob(new Blob([studyCsv(record)], { type: 'text/csv' }), `dwf-${record.sessionId}.csv`);
    });
  });
  dom.studyList.querySelectorAll<HTMLButtonElement>('[data-video]').forEach((button) => {
    button.addEventListener('click', () => {
      const record = state.studyRecords.find((item) => item.id === button.dataset.video);
      if (record?.video) downloadBlob(record.video, `dwf-${record.sessionId}.webm`);
    });
  });
}

async function startStudy(): Promise<void> {
  if (!state.sessionId) {
    toast('Start a session first.', 'warn');
    return;
  }
  dom.studyStart.disabled = true;
  const result = await state.study.start(state.sessionId, state.goal, state.mode);
  dom.studyStart.disabled = false;
  if (!result.ok) {
    dom.studyStatus.textContent = 'not started';
    toast(result.error ?? 'Recording was not started.', 'warn');
    return;
  }
  state.study.onEnded = () => void stopStudy(true);
  dom.studyStatus.textContent = 'recording';
  dom.studyStop.disabled = false;
  dom.firstEditStatus.hidden = true;
  toast('Recording the tab you picked. The worksheet recording has no audio or galaxy overlay.', 'ok');
}

async function stopStudy(fromTrackEnd = false): Promise<void> {
  if (!state.study.active) return;
  dom.studyStop.disabled = true;
  const record = await state.study.stop();
  state.study.onEnded = null;
  dom.studyStatus.textContent = 'saved';
  dom.firstEditStatus.hidden = true;
  if (record) {
    state.studyRecords.push(record);
    await saveStudyRecord(record);
    downloadBlob(new Blob([studyCsv(record)], { type: 'text/csv' }), `dwf-${record.sessionId}.csv`);
    state.lastStudyCsv = record.id;
    dom.studyExport.disabled = false;
    renderStudyList();
    toast(fromTrackEnd ? 'Sharing stopped; recording saved and CSV exported.' : 'Recording saved. CSV exported.', 'ok');
  }
}

function describeFace(): void {
  const cue = state.liveFace;
  const cal = state.face.calibration;
  if (!state.face.running) {
    dom.facePill.textContent = 'off';
    return;
  }
  dom.facePill.textContent = !cue ? 'starting' : !cue.present ? 'no face' : cue.eyesClosed ? 'eyes closed' : cue.headDown ? 'head down' : 'head up';
  if (state.calibrating) return;
  if (!cal) {
    dom.faceStatus.textContent = 'Camera on. Calibrate once so “head down” means looking at your notes.';
  } else if (cue?.present) {
    dom.faceStatus.textContent = `Pitch ${cue.pitchDeg?.toFixed(0)}° toward notes (calibrated range ${Math.abs(cal.notesPitch - cal.screenPitch).toFixed(0)}°).`;
  }
}

async function startFace(): Promise<void> {
  dom.faceStart.disabled = true;
  try {
    await state.face.start((label) => (dom.faceStatus.textContent = label));
  } catch (error) {
    dom.faceStart.disabled = false;
    const denied = error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'SecurityError');
    dom.faceStatus.textContent = denied
      ? 'Camera permission was not granted. Full fusion will abstain; Screen-only mode still works.'
      : 'The face model could not start on this device. Full fusion will abstain; Screen-only mode still works.';
    return;
  }
  dom.facePreview.hidden = false;
  dom.facePreview.replaceChildren(state.face.video);
  dom.faceStart.hidden = true;
  dom.faceStop.hidden = false;
  dom.faceCalibrate.disabled = false;
  clearInterval(state.faceTimer);
  // Visible-tab refresh for the readout; live samples also trigger detection.
  state.faceTimer = window.setInterval(() => {
    if (document.visibilityState === 'visible') state.liveFace = state.face.sample(state.thresholds.headDownPitchDeg);
    describeFace();
  }, 500);
  state.study.log('mode', 'face cues on');
  if (!state.face.calibration) void calibrateFace();
}

async function calibrateFace(): Promise<void> {
  if (!state.face.running) return;
  if (state.frozen && state.face.calibration) {
    toast('Thresholds are frozen; unfreeze in Settings to recalibrate.', 'warn');
    return;
  }
  dom.faceCalibrate.disabled = true;
  state.calibrating = true;
  dom.faceStatus.textContent = 'Calibrating 1/2: look at your screen…';
  await sleep(600);
  const screen = await state.face.capturePose();
  dom.faceStatus.textContent = 'Calibrating 2/2: now look down at your notes…';
  await sleep(1200);
  const notes = await state.face.capturePose();
  dom.faceCalibrate.disabled = false;
  state.calibrating = false;
  if (screen === null || notes === null) {
    dom.faceStatus.textContent = 'No face was found during calibration. Sit in view of the camera and try again.';
    return;
  }
  if (Math.abs(notes - screen) < 4) {
    dom.faceStatus.textContent = 'Screen and notes poses looked the same. Tilt your head down further for step 2 and try again.';
    return;
  }
  state.face.saveCalibration(screen, notes);
  dom.faceStatus.textContent = `Calibrated: ${Math.abs(notes - screen).toFixed(0)}° between screen and notes.`;
  state.study.log('mode', `face calibrated span=${Math.abs(notes - screen).toFixed(1)}`);
}

function stopFace(): void {
  clearInterval(state.faceTimer);
  state.face.stop();
  state.liveFace = null;
  dom.facePreview.hidden = true;
  dom.facePreview.replaceChildren();
  dom.faceStart.hidden = false;
  dom.faceStart.disabled = false;
  dom.faceStop.hidden = true;
  dom.faceCalibrate.disabled = true;
  dom.faceStatus.textContent = 'Camera off. Full fusion will abstain without face cues.';
  describeFace();
}

async function renderPlanner(): Promise<void> {
  let entries: TraceEntry[] = [];
  try {
    const saved = await loadTraces();
    const current = new Set(state.trace.map((e) => e.id));
    entries = saved.flatMap((t) => t.entries ?? []).filter((e) => !current.has(e.id)).concat(state.trace);
  } catch {
    entries = state.trace;
  }
  const result = focusByHour(entries, 30 * 60 * 1000 / Math.max(100, state.thresholds.sessionTickMs * 2));
  const bars = $('planner-bars');
  const picks = new Set(result.suggestions.map((h) => h.hour));
  bars.innerHTML = result.hours
    .map((h) => `<i class="${h.samples ? 'has' : ''} ${picks.has(h.hour) ? 'pick' : ''}" style="height:${h.samples ? Math.max(6, Math.round(h.focus * 100)) : 3}%" title="${String(h.hour).padStart(2, '0')}:00 · ${h.samples} samples · ${Math.round(h.focus * 100)}% focused"></i>`)
    .join('');
  $('planner-count').textContent = `${result.totalSamples} samples`;
  const fmt = (h: number) => `${((h + 11) % 12) + 1}${h < 12 ? 'am' : 'pm'}`;
  $('planner-text').textContent = result.suggestions.length
    ? `Suggested deep-work blocks: ${result.suggestions.map((h) => `${fmt(h.hour)}–${fmt((h.hour + 1) % 24)} (${Math.round(h.focus * 100)}% focused)`).join(', ')}. From live sessions only.`
    : result.totalSamples
      ? `${result.totalSamples} live samples so far. Suggestions appear once an hour has about 30 minutes of decided samples.`
      : 'Your focus-by-hour curve builds from live sessions only (never the scripted demo). Start “Use my real screen” to collect it.';
}

function setupCapybara(): void {
  let typed = '';
  const svg = document.getElementById('capybara');
  window.addEventListener('keydown', (event) => {
    if ((event.target as HTMLElement).closest?.('input,textarea,select')) return;
    typed = (typed + event.key.toLowerCase()).slice(-8);
    if (!typed.endsWith('capybara') || !svg) return;
    svg.classList.add('on');
    window.setTimeout(() => svg.classList.remove('on'), 6000);
  });
}

function setupLive(): void {
  setupCapybara();
  void renderPlanner();
  dom.faceStart.addEventListener('click', () => void startFace());
  dom.faceCalibrate.addEventListener('click', () => void calibrateFace());
  dom.faceStop.addEventListener('click', stopFace);
  dom.liveBtn.addEventListener('click', () => {
    if (state.livePort) stopLive();
    else {
      beginSession();
      showSession();
      startLive();
    }
  });
}

function setupStudy(): void {
  dom.studyStart.addEventListener('click', () => void startStudy());
  dom.studyStop.addEventListener('click', () => void stopStudy());
  dom.studyExport.addEventListener('click', () => {
    const record = state.studyRecords.find((item) => item.id === state.lastStudyCsv) ?? state.studyRecords[state.studyRecords.length - 1];
    if (record) downloadBlob(new Blob([studyCsv(record)], { type: 'text/csv' }), `dwf-${record.sessionId}.csv`);
  });
}

function setupReplay(): void {
  dom.traceList.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('.trace-row');
    if (!button) return;
    renderReplayDetail(Number(button.dataset.index));
  });
  dom.replayRange.addEventListener('input', () => renderReplayDetail(Number(dom.replayRange.value)));
  dom.correctOnTask.addEventListener('click', () => correctSelected('on-task'));
  dom.correctDrift.addEventListener('click', () => correctSelected('drift'));
  dom.correctFive.addEventListener('click', correctFive);
  dom.rerun.addEventListener('click', rerunSimilar);
  dom.splitTest.addEventListener('click', addSplitTest);
  dom.clearCorrections.addEventListener('click', () => void clearCorrections());
}

function setupCapture(): void {
  dom.stepOpen.addEventListener('click', () => {
    if (!state.sessionId) {
      beginSession();
      showSession();
    }
    openDemoWorksheet();
  });
  dom.stepDrift.addEventListener('click', () => {
    if (!state.checkpoint) {
      toast('Save problem 4b first.', 'warn');
      return;
    }
    startScenario();
  });
  dom.resumeBtn.addEventListener('click', () => void resume());
  dom.resumeNudge.addEventListener('click', () => void resume());
  dom.nudgeDismiss.addEventListener('click', () => {
    dom.nudge.hidden = true;
    toast('Nudge dismissed. The next one waits for the cooldown.');
  });
  dom.resumeCopy.addEventListener('click', async () => {
    if (!state.checkpoint) return;
    const url = buildTextFragmentUrl(state.checkpoint.url, state.checkpoint);
    try {
      await navigator.clipboard.writeText(url);
      toast('Fragment URL copied.', 'ok');
    } catch {
      dom.replayDetail.textContent = url;
      toast('Clipboard blocked; the URL is shown in the replay panel.');
    }
  });
  dom.pipBtn.addEventListener('click', async () => {
    if (!state.galaxy) {
      toast('The galaxy renderer is not ready.', 'warn');
      return;
    }
    const result = await state.galaxy.openPiP();
    if (result === 'pip') {
      dom.miniPanel.hidden = true;
      toast('Mini-galaxy floating in its own window.', 'ok');
    } else {
      dom.miniPanel.hidden = false;
      toast('Document Picture-in-Picture is unavailable; using the in-page mini panel.', 'warn');
    }
  });
  dom.savedRetry.addEventListener('click', () => {
    dom.savedDialog.close();
    void resume();
  });
  dom.savedOpen.addEventListener('click', () => dom.savedDialog.close());
  window.addEventListener('message', (event) => {
    if (event.origin !== window.location.origin) return;
    const data = event.data as { source?: string; type?: string; chars?: number; qualifies?: boolean; newline?: boolean };
    if (!data || data.source !== 'dwf-demo-worksheet') return;
    if (data.type === 'dwf-edit') {
      onAnswerInput(Number(data.chars ?? 0), Boolean(data.newline));
    }
  });
}

function setupLanding(): void {
  $('try-btn').addEventListener('click', () => void tryItNow());
  const openExtension = () => {
    dom.extId.value = localStorage.getItem(STORAGE.extensionId) ?? '';
    openDialog(dom.extensionDialog);
  };
  $('extension-btn').addEventListener('click', openExtension);
  $('extension-btn-2').addEventListener('click', openExtension);
  dom.unsupportedExt.addEventListener('click', () => {
    dom.unsupportedDialog.close();
    openExtension();
  });
  $('url-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = $('url-input') as HTMLInputElement;
    const url = input.value.trim();
    let parsed: URL;
    try {
      parsed = new URL(url);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('protocol');
    } catch {
      toast('Enter a full http(s) assignment URL.', 'warn');
      return;
    }
    const opened = window.open(parsed.href, '_blank');
    dom.unsupportedBody.textContent = opened
      ? 'The page opened in a new tab. This hosted app cannot read another site’s page because of browser same-origin rules, so it will not claim a checkpoint or a verified restore here.'
      : 'The browser blocked the new tab. Even with the tab open, this hosted app cannot read another site’s page because of browser same-origin rules.';
    dom.unsupportedUrl.textContent = parsed.href;
    openDialog(dom.unsupportedDialog);
  });
  const upload = $('upload-input') as HTMLInputElement;
  upload.addEventListener('change', () => {
    const file = upload.files?.[0];
    if (file) void handleUpload(file);
    upload.value = '';
  });
  document.querySelectorAll<HTMLElement>('[data-close]').forEach((button) => {
    button.addEventListener('click', () => {
      const dialog = document.getElementById(button.dataset.close ?? '') as HTMLDialogElement | null;
      dialog?.close();
    });
  });
}

async function handleUpload(file: File): Promise<void> {
  beginSession();
  showSession();
  const win = window.open('about:blank', 'dwf-upload');
  if (!win) {
    toast('Allow popups to open the uploaded worksheet.', 'warn');
    return;
  }
  const blob = new Blob([await file.text()], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  try {
    win.location.href = url;
  } catch {
    win.location.assign(url);
  }
  if (!(await waitForWindow(win))) {
    toast('The uploaded worksheet did not load.', 'warn');
    return;
  }
  state.worksheet = win;
  try {
    const doc = win.document;
    const bar = doc.createElement('div');
    bar.style.cssText =
      'position:fixed;left:16px;bottom:16px;z-index:2147483647;display:flex;gap:8px;align-items:center;' +
      'padding:8px 12px;border-radius:999px;background:rgba(16,24,40,.94);color:#e7eefb;' +
      'font:12px ui-sans-serif,system-ui,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.3)';
    bar.innerHTML =
      '<span>Deep Work Field · uploaded worksheet</span>' +
      '<button id="dwf-save-spot" style="background:#f0b429;color:#211703;border:0;border-radius:999px;padding:6px 10px;font:600 11px ui-sans-serif,system-ui,sans-serif;cursor:pointer">Save this spot</button>';
    doc.body.appendChild(bar);
    bar.querySelector<HTMLButtonElement>('#dwf-save-spot')?.addEventListener('click', () => {
      const anchor = pickAnchorElement(doc);
      if (!anchor) {
        toast('Scroll to a heading or select text in the uploaded page first.', 'warn');
        return;
      }
      const checkpoint = captureCheckpointFromElement(doc, anchor, { goal: state.goal });
      if (!checkpoint) {
        toast('That passage could not be anchored. Choose a heading with visible text.', 'warn');
        return;
      }
      state.checkpoint = checkpoint;
      state.lastResumeUrl = buildTextFragmentUrl(checkpoint.url, checkpoint);
      void saveCheckpoint(checkpoint);
      renderCheckpoint();
      dom.stepDrift.disabled = false;
      dom.demoStep.textContent =
        'Uploaded checkpoint saved. Start the scripted drift, then Resume — the app will verify the passage in the uploaded document.';
      toast('Uploaded worksheet checkpoint saved.', 'ok');
    });
    doc.addEventListener('input', (event) => {
      const target = event.target as HTMLInputElement | HTMLTextAreaElement;
      if (target.matches?.('textarea,input')) onAnswerInput(target.value.length, target.value.includes('\n'));
    });
    dom.demoStep.textContent =
      'Uploaded worksheet opened. Scroll to a heading and click “Save this spot”, then simulate drift and resume.';
  } catch {
    toast('The uploaded page loaded but could not be instrumented (it may use a cross-origin frame).', 'warn');
  }
}

function setupExtensionBridge(): void {
  dom.extId.value = localStorage.getItem(STORAGE.extensionId) ?? '';
  dom.extId.placeholder = `${EXTENSION_ID} (default)`;
  // Re-check when the user comes back from chrome://extensions.
  window.addEventListener('focus', () => void pingExtension());
  dom.extCheck.addEventListener('click', () => {
    const id = dom.extId.value.trim();
    if (id) localStorage.setItem(STORAGE.extensionId, id);
    else localStorage.removeItem(STORAGE.extensionId);
    void pingExtension().then((connected) => {
      dom.extResult.textContent = connected
        ? 'Connected. The extension can save and restore checkpoints on third-party pages.'
        : 'No reply yet. Check the extension is loaded and enabled in chrome://extensions. If this site is not localhost or the published demo, its address must be listed in externally_connectable.';
    });
  });
  void pingExtension();
}

function pingExtension(): Promise<boolean> {
  const chromeApi = (globalThis as unknown as { chrome?: ChromeLike }).chrome;
  const id = extensionId();
  if (!chromeApi?.runtime?.sendMessage || !id) {
    setExtensionStatus(false);
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    try {
      chromeApi.runtime!.sendMessage!(id, { type: 'DWF_PING' }, (reply: { ok?: boolean }) => {
        const error = chromeApi.runtime!.lastError;
        const connected = !error && !!reply?.ok;
        setExtensionStatus(connected);
        resolve(connected);
      });
    } catch {
      setExtensionStatus(false);
      resolve(false);
    }
  });
}

function setExtensionStatus(connected: boolean): void {
  state.extensionConnected = connected;
  dom.extensionStatus.textContent = connected ? 'Extension: connected' : 'Extension: not linked';
  if (connected) dom.extResult.textContent = 'Connected. The extension can save and restore checkpoints on other sites.';
  dom.liveBtn.disabled = !connected;
  dom.liveBtn.title = connected ? 'Score your real active tab, through the extension' : 'Needs the Chrome extension';
  dom.extensionStatus.title = connected
    ? 'External messaging bridge answered.'
    : 'Install the extension (Get the extension); the hosted demo works without it.';
}

function setupDialogs(): void {
  document.querySelectorAll<HTMLDialogElement>('dialog.dialog').forEach((dialog) => {
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
  });
}

function setupSessionLifecycle(): void {
  const finalize = () => {
    if (!state.session) return;
    state.session.endedAt = Date.now();
    void saveSession(state.session);
    if (state.trace.length) void saveTrace(state.trace);
  };
  window.addEventListener('pagehide', finalize);
  window.addEventListener('beforeunload', finalize);
}

function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* offline caching is optional for the hosted demo */
    });
  });
}

function setup(): void {
  dom.modeSelect.value = state.mode;
  dom.modePill.textContent = modeName(state.mode);
  dom.freezePill.hidden = !state.frozen;
  dom.sessionGoal.textContent = state.goal;
  mountGalaxy();
  setupVoice();
  setupSettings();
  setupReplay();
  setupStudy();
  setupLive();
  setupCapture();
  setupLanding();
  setupDialogs();
  setupExtensionBridge();
  setupSessionLifecycle();
  registerServiceWorker();
  updateCorrectionPanel();
  void getAll('study').then((records) => {
    const typed = records as unknown as StudyRecord[];
    if (typed.length) {
      state.studyRecords = typed;
      renderStudyList();
    }
  });
}

setup();
