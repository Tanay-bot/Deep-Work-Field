import type { Checkpoint, VerifyResult } from '../../shared/src/types';
import { buildTextFragmentUrl } from '../../shared/src/fragments';
import { restoreStatusFromResult } from '../../shared/src/session';

const KEYS = {
  checkpoints: 'dwf:checkpoints',
  pending: 'dwf:pending',
  lastResult: 'dwf:lastResult',
  session: 'dwf:session',
};

type CheckpointList = Checkpoint[];

/** One restore = one operation, keyed by tab, identified by restoreId. */
interface PendingRestore {
  restoreId: string;
  checkpoint: Checkpoint;
  tabId: number;
  at: number;
}
type PendingMap = Record<string, PendingRestore>;
const RESTORE_TIMEOUT_MS = 60_000;

/** Serializes read-modify-write cycles on chrome.storage so saves and restores cannot clobber each other. */
let storageLock: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = storageLock.then(fn, fn);
  storageLock = run.catch(() => undefined);
  return run;
}

function restoreId(): string {
  return `rs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

async function readPending(): Promise<PendingMap> {
  const stored = await chrome.storage.local.get(KEYS.pending);
  const raw = stored[KEYS.pending];
  // Older builds stored a single record; drop it rather than misattribute it.
  if (!raw || typeof raw !== 'object' || 'checkpoint' in raw) return {};
  const now = Date.now();
  const live: PendingMap = {};
  for (const [tab, entry] of Object.entries(raw as PendingMap)) {
    if (entry && now - entry.at < RESTORE_TIMEOUT_MS) live[tab] = entry;
  }
  return live;
}

async function readCheckpoints(): Promise<CheckpointList> {
  const stored = await chrome.storage.local.get(KEYS.checkpoints);
  return Array.isArray(stored[KEYS.checkpoints]) ? stored[KEYS.checkpoints] : [];
}

async function writeCheckpoints(list: CheckpointList): Promise<void> {
  await chrome.storage.local.set({ [KEYS.checkpoints]: list.slice(0, 25) });
}

async function getPending(tabId?: number): Promise<PendingRestore | null> {
  if (tabId === undefined) return null;
  const map = await readPending();
  return map[String(tabId)] ?? null;
}

async function settlePending(tabId: number, id: string): Promise<boolean> {
  return withLock(async () => {
    const map = await readPending();
    const entry = map[String(tabId)];
    if (!entry || entry.restoreId !== id) return false;
    delete map[String(tabId)];
    await chrome.storage.local.set({ [KEYS.pending]: map });
    return true;
  });
}

async function setBadge(text: string, color: string): Promise<void> {
  try {
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color });
  } catch {
    /* badge is cosmetic */
  }
}

async function activeTab(): Promise<any> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

/* ---------- Narrow site access ------------------------------------------
 * The extension has no site access at install. The popup asks for a single
 * site when you save or restore there (optional_host_permissions). The
 * content script is then registered only for the sites you approved, and is
 * injected on demand into the tab you invoked the popup on (activeTab).
 */
function originPattern(url: string): string | null {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? `${u.origin}/*` : null;
  } catch {
    return null;
  }
}

async function hasSiteAccess(url: string): Promise<boolean> {
  const pattern = originPattern(url);
  if (!pattern) return false;
  try {
    return await chrome.permissions.contains({ origins: [pattern] });
  } catch {
    return false;
  }
}

/** Makes sure the content script is in a tab (activeTab or a granted site). */
async function ensureContentScript(tabId: number): Promise<boolean> {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: 'DWF_CS_PING' });
    if (pong?.ok) return true;
  } catch {
    /* not injected yet */
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return true;
  } catch {
    return false;
  }
}

/** Registers the content script for exactly the granted origins. */
async function syncRegisteredScripts(): Promise<void> {
  try {
    const { origins = [] } = await chrome.permissions.getAll();
    const matches = origins.filter((o: string) => o === '<all_urls>' || /^https?:\/\//.test(o));
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: ['dwf-granted'] }).catch(() => []);
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: ['dwf-granted'] });
    if (matches.length) {
      await chrome.scripting.registerContentScripts([
        { id: 'dwf-granted', matches, js: ['content.js'], runAt: 'document_idle', persistAcrossSessions: true },
      ]);
    }
  } catch {
    /* registration is best-effort; on-demand injection still works */
  }
}

chrome.permissions.onAdded.addListener(() => void syncRegisteredScripts());
chrome.permissions.onRemoved.addListener(() => void syncRegisteredScripts());
chrome.runtime.onStartup.addListener(() => void syncRegisteredScripts());

async function captureOnTab(tab: any, goal: string, screenshot = false): Promise<{ ok: boolean; checkpoint?: Checkpoint; error?: string }> {
  if (!tab?.id) return { ok: false, error: 'No active tab.' };
  await ensureContentScript(tab.id);
  let reply: any = null;
  try {
    reply = await chrome.tabs.sendMessage(tab.id, { type: 'DWF_CAPTURE', goal });
  } catch (error) {
    return { ok: false, error: 'The content script is not available on this page (chrome:// pages and the Chrome Web Store cannot be captured).' };
  }
  if (!reply?.ok || !reply.checkpoint) {
    return { ok: false, error: reply?.error ?? 'No citable passage was found on this page.' };
  }
  const checkpoint: Checkpoint = reply.checkpoint;
  // The frame must show the tab that was captured. If the user switched tabs
  // in the meantime, skip it rather than save a picture of something else.
  // Screenshots are opt-in (popup checkbox).
  try {
    const now = screenshot ? await activeTab() : null;
    if (now && now.id === tab.id && now.windowId === tab.windowId) {
      checkpoint.savedFrame = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 55 });
    }
  } catch {
    /* captures can be blocked by policy; the checkpoint is still useful */
  }
  await withLock(async () => {
    const list = await readCheckpoints();
    list.unshift(checkpoint);
    await writeCheckpoints(list);
  });
  await chrome.storage.local.set({ [KEYS.session]: { goal, checkpointId: checkpoint.id, startedAt: Date.now() } });
  await setBadge('●', '#45d6ab');
  // The web page only needs to know what was saved, not the passage text,
  // answer draft or screenshot, which stay inside the extension.
  return { ok: true, checkpoint: { ...checkpoint, savedFrame: undefined, answerRegion: undefined } };
}

async function restoreCheckpoint(id: string): Promise<{ ok: boolean; error?: string; url?: string }> {
  const list = await readCheckpoints();
  const checkpoint = list.find((item) => item.id === id);
  if (!checkpoint) return { ok: false, error: 'Checkpoint not found.' };
  if (!checkpoint.url.startsWith('chrome-extension://') && !(await hasSiteAccess(checkpoint.url))) {
    return { ok: false, error: 'Deep Work Field needs access to this site to verify the restore. Use Return in the popup and allow the site.' };
  }
  // PDF checkpoints reopen the bundled viewer; its own script finds and verifies the passage.
  const isViewer = checkpoint.url.startsWith(chrome.runtime.getURL('pdf/viewer.html'));
  const url = isViewer ? checkpoint.url : buildTextFragmentUrl(checkpoint.url, checkpoint);
  // Open the fragment URL directly: Chrome only runs scroll-to-text on a
  // fresh browser navigation, not on a later update of a blank tab. The page
  // cannot reach document_idle before this registration lands, and the
  // content script also retries briefly, so it always finds its own restore.
  let tab: any;
  try {
    tab = await chrome.tabs.create({ url, active: true });
  } catch (error) {
    return { ok: false, error: 'Could not open a tab for the restore.' };
  }
  if (!tab?.id) return { ok: false, error: 'Could not open a tab for the restore.' };
  const op: PendingRestore = { restoreId: restoreId(), checkpoint, tabId: tab.id, at: Date.now() };
  await withLock(async () => {
    const map = await readPending();
    map[String(tab.id)] = op;
    await chrome.storage.local.set({
      [KEYS.pending]: map,
      [KEYS.lastResult]: { checkpointId: id, restoreId: op.restoreId, status: 'restoring', at: Date.now() },
    });
  });
  return { ok: true, url, restoreId: op.restoreId } as { ok: boolean; url: string; restoreId: string };
}

async function externalMessage(message: any, sender: any): Promise<any> {
  switch (message?.type) {
    case 'DWF_PING':
      return { ok: true, version: chrome.runtime.getManifest().version };
    case 'DWF_SAVE_CHECKPOINT': {
      const tab = await activeTab();
      return captureOnTab(tab, typeof message.goal === 'string' ? message.goal : '');
    }
    case 'DWF_RESTORE':
      return restoreCheckpoint(String(message.id ?? ''));
    case 'DWF_LIST': {
      const list = await readCheckpoints();
      return { ok: true, checkpoints: list.map(({ savedFrame, ...rest }) => rest) };
    }
    case 'DWF_STATUS':
      return { ok: true, lastResult: (await chrome.storage.local.get(KEYS.lastResult))[KEYS.lastResult] ?? null };
    default:
      return { ok: false, error: 'Unknown message.' };
  }
}

chrome.runtime.onMessageExternal.addListener((message: any, sender: any, sendResponse: (reply: any) => void) => {
  void externalMessage(message, sender)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: String(error) }));
  return true;
});

chrome.runtime.onMessage.addListener((message: any, sender: any, sendResponse: (reply: any) => void) => {
  if (message?.type === 'DWF_SAVE_PDF_CHECKPOINT') {
    const viewer = chrome.runtime.getURL('pdf/viewer.html');
    const checkpoint: Checkpoint | undefined = message.checkpoint;
    if (!checkpoint?.id || !sender.url?.startsWith(viewer) || !checkpoint.url?.startsWith(viewer)) {
      sendResponse({ ok: false, error: 'Only the Deep Work Field PDF viewer can save PDF checkpoints.' });
      return false;
    }
    void withLock(async () => {
      const list = await readCheckpoints();
      list.unshift(checkpoint);
      await writeCheckpoints(list);
    })
      .then(() => setBadge('●', '#45d6ab'))
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (message?.type === 'DWF_SCREEN') {
    if (sender.tab?.id === streamingTab && ports.size) {
      post({ url: String(message.url ?? ''), title: String(message.title ?? ''), text: String(message.text ?? '').slice(0, 1600), restricted: false });
    }
    return false;
  }
  if (message?.type === 'DWF_GET_PENDING') {
    void getPending(sender.tab?.id)
      .then((pending) => sendResponse({ pending }))
      .catch(() => sendResponse({ pending: null }));
    return true;
  }
  if (message?.type === 'DWF_VERIFY_RESULT') {
    const result: VerifyResult = message.result;
    const tabId = sender.tab?.id;
    const id = String(message.restoreId ?? '');
    // Only the operation that is still pending for THIS tab may settle it;
    // a stale reply from an older restore is ignored, not recorded.
    void (async () => {
      if (tabId === undefined || !(await settlePending(tabId, id))) {
        sendResponse({ ok: false, stale: true });
        return;
      }
      await chrome.storage.local.set({
        [KEYS.lastResult]: {
          checkpointId: message.checkpointId,
          restoreId: id,
          status: restoreStatusFromResult(result),
          reason: result.reason,
          landing: result.landing,
          attempts: result.attempts,
          at: Date.now(),
        },
      });
      await setBadge(result.ok ? '✓' : '!', result.ok ? '#45d6ab' : '#f0b429');
      // Same vocabulary, straight into any listening web session.
      post({ type: 'restore', status: restoreStatusFromResult(result), reason: result.reason, landing: result.landing });
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (message?.type === 'DWF_ANSWER_EDIT') {
    void chrome.storage.local.get(KEYS.session).then((stored: any) => {
      const session = stored[KEYS.session] ?? {};
      const next = {
        ...session,
        firstQualifyingEditAt: session.firstQualifyingEditAt ?? Date.now(),
        lastEdit: { problemId: message.problemId, chars: message.chars, at: Date.now() },
      };
      void chrome.storage.local.set({ [KEYS.session]: next });
      void setBadge('✓', '#45d6ab');
    });
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === 'DWF_SAVE_CHECKPOINT_FROM_POPUP') {
    void activeTab()
      .then((tab) => captureOnTab(tab, String(message.goal ?? ''), message.screenshot === true))
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (message?.type === 'DWF_RESTORE_FROM_POPUP') {
    void restoreCheckpoint(String(message.id ?? ''))
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (message?.type === 'DWF_LIST_FROM_POPUP') {
    void readCheckpoints()
      .then((list) => sendResponse({ ok: true, checkpoints: list.map(({ savedFrame, ...rest }) => rest) }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  return false;
});

/* ---------- Live screen stream to the web app ---------------------------- */
// The web app opens a port (externally_connectable). While at least one port
// is open, the visible active tab streams its on-screen text once a second.
// Pages the content script cannot run on are reported as restricted, by title.
const ports = new Set<any>();
let streamingTab: number | null = null;

function post(sample: Record<string, unknown>): void {
  for (const port of ports) {
    try {
      port.postMessage({ type: 'screen', t: Date.now(), ...sample });
    } catch {
      ports.delete(port);
    }
  }
}

async function streamActiveTab(): Promise<void> {
  if (!ports.size) return;
  const tab = await activeTab().catch(() => null);
  if (!tab?.id) return;
  if (streamingTab !== null && streamingTab !== tab.id) {
    chrome.tabs.sendMessage(streamingTab, { type: 'DWF_STREAM', on: false }).catch(() => undefined);
  }
  streamingTab = tab.id;
  const url = tab.url ?? tab.pendingUrl ?? '';
  // Full visible text only on sites the user granted; elsewhere the tab title
  // (available through the "tabs" permission) is the evidence.
  if ((await hasSiteAccess(url)) && (await ensureContentScript(tab.id))) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'DWF_STREAM', on: true });
      return;
    } catch {
      /* fall through to title-only */
    }
  }
  post({ url, title: tab.title ?? '', text: '', restricted: true });
}

function stopAllStreams(): void {
  if (streamingTab !== null) chrome.tabs.sendMessage(streamingTab, { type: 'DWF_STREAM', on: false }).catch(() => undefined);
  streamingTab = null;
}

chrome.runtime.onConnectExternal.addListener((port: any) => {
  if (port.name !== 'dwf-screen') return;
  ports.add(port);
  port.onDisconnect.addListener(() => {
    ports.delete(port);
    if (!ports.size) stopAllStreams();
  });
  void streamActiveTab();
});

chrome.tabs.onActivated.addListener(() => void streamActiveTab());
// Title-only tabs have no content script ticking, so refresh them every 1 s
// (the same cadence as the text stream; the engine treats >1.5 s gaps as
// stale evidence) while a session listens. The open port keeps the worker alive.
setInterval(() => {
  if (ports.size) void restrictedTick();
}, 1000);
async function restrictedTick(): Promise<void> {
  const tab = await activeTab().catch(() => null);
  if (!tab?.id || tab.id !== streamingTab) return;
  const url = tab.url ?? '';
  if (await hasSiteAccess(url)) return;
  post({ url, title: tab.title ?? '', text: '', restricted: true });
}
chrome.windows.onFocusChanged.addListener(() => void streamActiveTab());
chrome.tabs.onUpdated.addListener((tabId: number, info: any) => {
  if (info.status === 'complete' && tabId === streamingTab) void streamActiveTab();
});

chrome.tabs.onRemoved.addListener((tabId: number) => {
  void withLock(async () => {
    const map = await readPending();
    const entry = map[String(tabId)];
    if (!entry) return;
    delete map[String(tabId)];
    await chrome.storage.local.set({
      [KEYS.pending]: map,
      [KEYS.lastResult]: { checkpointId: entry.checkpoint.id, restoreId: entry.restoreId, status: 'cancelled', reason: 'tab-closed', at: Date.now() },
    });
    post({ type: 'restore', status: 'cancelled', reason: 'tab-closed' });
  });
});

chrome.runtime.onInstalled.addListener(() => {
  void syncRegisteredScripts();
  void chrome.storage.local.set({ [KEYS.lastResult]: { status: 'installed', at: Date.now() } });
  void setBadge('', '#45d6ab');
});
