import type { Checkpoint, VerifyResult } from '../../shared/src/types';
import { captureCheckpointFromElement, captureCheckpointFromRange, pickAnchorElement } from '../../shared/src/checkpoint';
import { verifyCheckpointAsync } from '../../shared/src/verify';

declare const chrome: any;

let activeCheckpoint: Checkpoint | null = null;
let editLogged = false;
let detachEdit: (() => void) | null = null;

function shadowHost(id: string): { host: HTMLElement; root: ShadowRoot } {
  let host = document.getElementById(id);
  if (!host) {
    host = document.createElement('div');
    host.id = id;
    host.style.cssText = 'position:fixed;z-index:2147483647;top:16px;right:16px;max-width:360px;font-family:ui-sans-serif,system-ui,sans-serif';
    document.documentElement.appendChild(host);
  }
  const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
  return { host, root };
}

function removeOverlay(id: string): void {
  document.getElementById(id)?.remove();
}

function showSuccess(checkpoint: Checkpoint, result: VerifyResult): void {
  removeOverlay('dwf-saved-context');
  const { host, root } = shadowHost('dwf-restored');
  host.style.cssText += ';top:16px;right:16px';
  root.innerHTML = `
    <style>
      .card{background:#0f766e;color:#f0fdfa;border-radius:12px;padding:12px 15px;box-shadow:0 14px 40px rgba(15,118,110,.35);font-size:13px;line-height:1.45}
      b{display:block;font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.8;margin-bottom:3px}
      small{display:block;opacity:.78;font-size:11px;margin-top:4px}
    </style>
    <div class="card"><b>Verified restore</b>${checkpoint.anchor.replace(/</g, '&lt;')}
      <small>prefix/suffix matched · passage in viewport · ${result.attempts} attempt(s)</small></div>`;
  setTimeout(() => host.remove(), 7000);
}

function showSavedContext(checkpoint: Checkpoint, result: VerifyResult): void {
  removeOverlay('dwf-restored');
  const { root } = shadowHost('dwf-saved-context');
  const frame = checkpoint.savedFrame
    ? `<img alt="Last on-task frame" src="${checkpoint.savedFrame}" style="max-width:100%;border-radius:7px;margin-top:8px;border:1px solid #334155" />`
    : '';
  root.innerHTML = `
    <style>
      .card{background:#111a2b;color:#e7eefb;border:1px solid #3b4a63;border-radius:12px;padding:14px 16px;box-shadow:0 14px 40px rgba(0,0,0,.45);font-size:13px;line-height:1.5}
      .tag{display:inline-block;background:rgba(240,180,41,.14);color:#f0b429;border:1px solid rgba(240,180,41,.4);border-radius:999px;padding:2px 8px;font-size:9px;letter-spacing:.12em;text-transform:uppercase;margin-bottom:6px}
      .anchor{font-family:Georgia,serif;font-size:15px;margin:0 0 6px}
      .ctx{font-family:ui-monospace,monospace;font-size:10px;color:#93a3bc;word-break:break-word}
      .reason{color:#ffc2b1;font-size:11.5px;margin-top:7px}
      button{position:absolute;right:10px;top:8px;background:transparent;border:0;color:#93a3bc;font-size:18px;cursor:pointer}
      small{display:block;color:#93a3bc;font-size:10.5px;margin-top:7px}
    </style>
    <div class="card" role="status">
      <button id="dwf-close" aria-label="Dismiss">×</button>
      <span class="tag">Saved context only</span>
      <p class="anchor">${checkpoint.anchor.replace(/</g, '&lt;')}</p>
      <div class="ctx">… ${checkpoint.prefix.replace(/</g, '&lt;')} [${checkpoint.anchor.replace(/</g, '&lt;')}] ${checkpoint.suffix.replace(/</g, '&lt;')} …</div>
      <div class="reason">${result.reason === 'ambiguous' ? `Multiple matching passages: ${result.contextMatches ?? 'several'} places have the same text before and after it, so none was picked.` : result.reason === 'context-mismatch' ? 'The surrounding text did not match the checkpoint.' : result.reason === 'not-in-viewport' ? 'The passage never landed inside the viewport.' : result.reason === 'no-match' ? 'The saved passage was not found on this page.' : 'The page could not be verified.'}</div>
      ${frame}
      <small>Nothing was verified, so Deep Work Field is not claiming a resume.</small>
    </div>`;
  root.querySelector('#dwf-close')?.addEventListener('click', () => document.getElementById('dwf-saved-context')?.remove());
}

async function verifyPending(): Promise<void> {
  // A restore tab can load before the worker finishes registering it, so
  // ask a few times. Ordinary pages simply never get a pending restore.
  let pending: any = null;
  for (let attempt = 0; attempt < 5 && !pending?.checkpoint; attempt++) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 250));
    try {
      pending = (await chrome.runtime.sendMessage({ type: 'DWF_GET_PENDING' }))?.pending ?? null;
    } catch {
      return;
    }
  }
  if (!pending?.checkpoint) return;
  const checkpoint: Checkpoint = pending.checkpoint;
  activeCheckpoint = checkpoint;
  // Allow the page to finish its own layout and Chrome's fragment scroll.
  await new Promise((resolve) => setTimeout(resolve, 500));
  const result = await verifyCheckpointAsync(document, checkpoint, {
    attempts: 14,
    retryMs: 300,
    scrollAfter: 2,
  });
  const { range, ...plain } = result;
  try {
    await chrome.runtime.sendMessage({ type: 'DWF_VERIFY_RESULT', checkpointId: checkpoint.id, restoreId: pending.restoreId, result: plain });
  } catch {
    /* the worker may be asleep; the overlay still reflects the local result */
  }
  if (result.ok) {
    showSuccess(checkpoint, result);
    attachEditTracking(checkpoint, range);
  } else {
    showSavedContext(checkpoint, result);
  }
}

/**
 * Tracks the first qualifying edit in the answer field that belongs to the
 * verified passage (same problem/section container as the verified range).
 * No confident link → no metric. Measured from the field's starting value.
 */
function attachEditTracking(checkpoint: Checkpoint, verified?: Range): void {
  detachEdit?.();
  detachEdit = null;
  const origin = verified?.startContainer.parentElement ?? null;
  const host =
    (origin?.closest('[data-answer-region],[data-problem-id],section,form,fieldset') as Element | null) ??
    (checkpoint.selectorHint ? document.querySelector(checkpoint.selectorHint) : null);
  const field = host?.querySelector('textarea,input,[contenteditable="true"]') as HTMLElement | null;
  if (!field) return;
  const read = () => ('value' in field ? String((field as HTMLInputElement).value ?? '') : (field.textContent ?? ''));
  const baseline = read();
  const handler = () => {
    if (editLogged || activeCheckpoint?.id !== checkpoint.id) return;
    const value = read();
    const added = value.length - baseline.length;
    const newline = (value.match(/\n/g)?.length ?? 0) > (baseline.match(/\n/g)?.length ?? 0);
    if (added < 10 && !newline) return;
    editLogged = true;
    try {
      chrome.runtime.sendMessage({ type: 'DWF_ANSWER_EDIT', problemId: checkpoint.problemId, checkpointId: checkpoint.id, chars: added });
    } catch {
      /* worker asleep */
    }
  };
  field.addEventListener('input', handler);
  detachEdit = () => field.removeEventListener('input', handler);
}

function capture(goal: string, sendResponse: (reply: any) => void): void {
  const selection = window.getSelection();
  const range = selection && !selection.isCollapsed && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  let checkpoint: Checkpoint | null = null;
  if (range) {
    // Save exactly what was selected. If it cannot be mapped, say so instead
    // of silently saving some other occurrence of the same words.
    checkpoint = captureCheckpointFromRange(document, range, { goal });
    if (!checkpoint) {
      sendResponse({ ok: false, error: 'Your selection could not be mapped to the page text, so nothing was saved. Try selecting plain text in one paragraph.' });
      return;
    }
  } else {
    const element = pickAnchorElement(document);
    if (!element) {
      sendResponse({ ok: false, error: 'No heading or paragraph is visible to anchor.' });
      return;
    }
    checkpoint = captureCheckpointFromElement(document, element, { goal });
    if (!checkpoint) {
      sendResponse({ ok: false, error: 'The visible passage could not be indexed (it may be canvas-rendered).' });
      return;
    }
  }
  activeCheckpoint = checkpoint;
  editLogged = false;
  attachEditTracking(checkpoint, range ?? undefined);
  sendResponse({ ok: true, checkpoint });
}

chrome.runtime.onMessage.addListener((message: any, _sender: any, sendResponse: (reply: any) => void) => {
  if (message?.type === 'DWF_CAPTURE') {
    capture(String(message.goal ?? ''), sendResponse);
    return false;
  }
  if (message?.type === 'DWF_VERIFY_NOW') {
    void verifyPending().then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

if (document.readyState === 'complete' || document.readyState === 'interactive') {
  void verifyPending();
} else {
  window.addEventListener('DOMContentLoaded', () => void verifyPending(), { once: true });
}
