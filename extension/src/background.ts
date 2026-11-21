import type { Checkpoint, VerifyResult } from '../../shared/src/types';
import { buildTextFragmentUrl } from '../../shared/src/fragments';

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

async function captureOnTab(tab: any, goal: string): Promise<{ ok: boolean; checkpoint?: Checkpoint; error?: string }> {
  if (!tab?.id) return { ok: false, error: 'No active tab.' };
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
  try {
    const now = await activeTab();
    if (now?.id === tab.id && now?.windowId === tab.windowId) {
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
  const url = buildTextFragmentUrl(checkpoint.url, checkpoint);
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
      [KEYS.lastResult]: { checkpointId: id, restoreId: op.restoreId, status: 'pending', at: Date.now() },
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
          status: result.ok ? 'verified' : result.reason === 'ambiguous' ? 'ambiguous' : 'saved-context',
          reason: result.reason,
          landing: result.landing,
          attempts: result.attempts,
          at: Date.now(),
        },
      });
      await setBadge(result.ok ? '✓' : '!', result.ok ? '#45d6ab' : '#f0b429');
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
      .then((tab) => captureOnTab(tab, String(message.goal ?? '')))
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
  });
});

chrome.runtime.onInstalled.addListener(() => {
  void chrome.storage.local.set({ [KEYS.lastResult]: { status: 'installed', at: Date.now() } });
  void setBadge('', '#45d6ab');
});
