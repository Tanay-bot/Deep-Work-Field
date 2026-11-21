import type { Checkpoint, VerifyResult } from '../../shared/src/types';
import { buildTextFragmentUrl } from '../../shared/src/fragments';

const KEYS = {
  checkpoints: 'dwf:checkpoints',
  pending: 'dwf:pending',
  lastResult: 'dwf:lastResult',
  session: 'dwf:session',
};

type CheckpointList = Checkpoint[];

async function readCheckpoints(): Promise<CheckpointList> {
  const stored = await chrome.storage.local.get(KEYS.checkpoints);
  return Array.isArray(stored[KEYS.checkpoints]) ? stored[KEYS.checkpoints] : [];
}

async function writeCheckpoints(list: CheckpointList): Promise<void> {
  await chrome.storage.local.set({ [KEYS.checkpoints]: list.slice(0, 25) });
}

async function getPending(tabId?: number): Promise<{ checkpoint: Checkpoint; tabId: number; at: number } | null> {
  const stored = await chrome.storage.local.get(KEYS.pending);
  const pending = stored[KEYS.pending];
  if (!pending || (tabId !== undefined && pending.tabId !== tabId)) return null;
  return pending;
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
  try {
    const frame = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 55 });
    checkpoint.savedFrame = frame;
  } catch {
    /* captures can be blocked by policy; the checkpoint is still useful */
  }
  const list = await readCheckpoints();
  list.unshift(checkpoint);
  await writeCheckpoints(list);
  await chrome.storage.local.set({ [KEYS.session]: { goal, checkpointId: checkpoint.id, startedAt: Date.now() } });
  await setBadge('●', '#45d6ab');
  return { ok: true, checkpoint };
}

async function restoreCheckpoint(id: string): Promise<{ ok: boolean; error?: string; url?: string }> {
  const list = await readCheckpoints();
  const checkpoint = list.find((item) => item.id === id);
  if (!checkpoint) return { ok: false, error: 'Checkpoint not found.' };
  const url = buildTextFragmentUrl(checkpoint.url, checkpoint);
  let tab: any;
  try {
    tab = await chrome.tabs.create({ url, active: true });
  } catch (error) {
    return { ok: false, error: 'Could not open a tab for the restore.' };
  }
  if (!tab?.id) return { ok: false, error: 'Could not open a tab for the restore.' };
  await chrome.storage.local.set({
    [KEYS.pending]: { checkpoint, tabId: tab.id, at: Date.now() },
    [KEYS.lastResult]: { checkpointId: id, status: 'pending', at: Date.now() },
  });
  return { ok: true, url };
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
    const checkpointId = message.checkpointId;
    void chrome.storage.local.set({
      [KEYS.lastResult]: { checkpointId, status: result.ok ? 'verified' : 'saved-context', reason: result.reason, attempts: result.attempts, at: Date.now() },
    });
    if (result.ok) {
      void setBadge('✓', '#45d6ab');
      void chrome.storage.local.remove(KEYS.pending);
    } else {
      void setBadge('!', '#f0b429');
    }
    sendResponse({ ok: true });
    return false;
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

chrome.runtime.onInstalled.addListener(() => {
  void chrome.storage.local.set({ [KEYS.lastResult]: { status: 'installed', at: Date.now() } });
  void setBadge('', '#45d6ab');
});
