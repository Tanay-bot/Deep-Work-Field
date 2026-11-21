import type { Checkpoint, VerifyResult } from '../../shared/src/types';
import { captureCheckpointFromElement, findAnswerRegion, pickAnchorElement } from '../../shared/src/checkpoint';
import { verifyCheckpointAsync } from '../../shared/src/verify';

declare const chrome: any;

let activeCheckpoint: Checkpoint | null = null;
let editLogged = false;

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
      <div class="reason">${result.reason === 'context-mismatch' ? 'The surrounding text did not match the checkpoint.' : result.reason === 'not-in-viewport' ? 'The passage never landed inside the viewport.' : result.reason === 'no-match' ? 'The saved passage was not found on this page.' : 'The page could not be verified.'}</div>
      ${frame}
      <small>Nothing was verified, so Deep Work Field is not claiming a resume.</small>
    </div>`;
  root.querySelector('#dwf-close')?.addEventListener('click', () => document.getElementById('dwf-saved-context')?.remove());
}

async function verifyPending(): Promise<void> {
  let reply: any;
  try {
    reply = await chrome.runtime.sendMessage({ type: 'DWF_GET_PENDING' });
  } catch {
    return;
  }
  const pending = reply?.pending;
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
  try {
    await chrome.runtime.sendMessage({ type: 'DWF_VERIFY_RESULT', checkpointId: checkpoint.id, result });
  } catch {
    /* the worker may be asleep; the overlay still reflects the local result */
  }
  if (result.ok) {
    showSuccess(checkpoint, result);
    attachEditTracking(checkpoint);
  } else {
    showSavedContext(checkpoint, result);
  }
}

function attachEditTracking(checkpoint: Checkpoint): void {
  if (editLogged) return;
  const region = checkpoint.selectorHint
    ? document.querySelector(checkpoint.selectorHint) ?? findAnswerRegion(document, pickAnchorElement(document) ?? document.body)
    : findAnswerRegion(document, pickAnchorElement(document) ?? document.body);
  const field = region?.querySelector('textarea,input,[contenteditable="true"]') as HTMLElement | null;
  if (!field) return;
  const handler = () => {
    if (editLogged || !activeCheckpoint) return;
    const value = 'value' in field ? String((field as HTMLInputElement).value ?? '') : (field.textContent ?? '');
    const newline = value.includes('\n');
    if (value.length < 10 && !newline) return;
    editLogged = true;
    try {
      chrome.runtime.sendMessage({
        type: 'DWF_ANSWER_EDIT',
        problemId: activeCheckpoint.problemId,
        chars: value.length,
      });
    } catch {
      /* worker asleep */
    }
  };
  field.addEventListener('input', handler);
}

function capture(goal: string, sendResponse: (reply: any) => void): void {
  const selection = window.getSelection();
  const selectedText = selection && !selection.isCollapsed ? selection.toString() : '';
  const element = selectedText
    ? (selection!.getRangeAt(0).startContainer.parentElement ?? pickAnchorElement(document))
    : pickAnchorElement(document);
  if (!element) {
    sendResponse({ ok: false, error: 'No heading or paragraph is visible to anchor.' });
    return;
  }
  const region = element.closest('section,form,fieldset,[data-answer-region]') ?? element.parentElement;
  const answerRegion = region?.querySelector('textarea,input,[contenteditable="true"]') as HTMLElement | null;
  const checkpoint = captureCheckpointFromElement(document, element, {
    goal,
    anchorText: selectedText || undefined,
    savedFrame: undefined,
    answerRegion: answerRegion
      ? 'value' in answerRegion
        ? String((answerRegion as HTMLInputElement).value ?? '').slice(0, 300)
        : (answerRegion.textContent ?? '').slice(0, 300)
      : undefined,
  });
  if (!checkpoint) {
    sendResponse({ ok: false, error: 'The visible passage could not be indexed (it may be canvas-rendered).' });
    return;
  }
  activeCheckpoint = checkpoint;
  editLogged = false;
  attachEditTracking(checkpoint);
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
