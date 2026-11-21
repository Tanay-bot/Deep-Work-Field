declare const chrome: any;
export {};

interface PopupCheckpoint {
  id: string;
  anchor: string;
  problemId: string;
  title: string;
  url: string;
  createdAt: number;
}

const goalInput = document.getElementById('goal') as HTMLInputElement;
const saveButton = document.getElementById('save') as HTMLButtonElement;
const status = document.getElementById('status') as HTMLElement;
const list = document.getElementById('list') as HTMLElement;
const result = document.getElementById('result') as HTMLElement;
const copyId = document.getElementById('copy-id') as HTMLButtonElement;

function setStatus(text: string, kind: 'ok' | 'warn' | 'muted' = 'muted'): void {
  status.textContent = text;
  status.dataset.kind = kind;
}

function relative(ts: number): string {
  const seconds = Math.round((Date.now() - ts) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

async function refresh(): Promise<void> {
  const stored = await chrome.storage.local.get(['dwf:goal', 'dwf:lastResult']);
  goalInput.value = stored['dwf:goal'] ?? 'AP Chem unit 4';
  const last = stored['dwf:lastResult'];
  if (last?.status === 'verified') result.textContent = `Last restore verified (${relative(last.at)}).`;
  else if (last?.status === 'saved-context') result.textContent = `Last restore failed verification (${last.reason}); saved context was shown.`;
  else if (last?.status === 'pending') result.textContent = 'A restore tab is opening; verification is running.';
  else result.textContent = 'No restore checked yet.';
  result.dataset.kind = last?.status === 'verified' ? 'ok' : last?.status === 'saved-context' ? 'warn' : 'muted';

  let reply: any = null;
  try {
    reply = await chrome.runtime.sendMessage({ type: 'DWF_LIST_FROM_POPUP' });
  } catch {
    reply = null;
  }
  const checkpoints: PopupCheckpoint[] = reply?.checkpoints ?? [];
  if (!checkpoints.length) {
    list.innerHTML = '<li class="empty">No checkpoints yet. Open a worksheet and save your spot.</li>';
    return;
  }
  list.innerHTML = checkpoints
    .slice(0, 8)
    .map(
      (checkpoint) =>
        `<li><div class="grow"><strong>${checkpoint.anchor.replace(/</g, '&lt;').slice(0, 76)}</strong>` +
        `<span>${checkpoint.title.replace(/</g, '&lt;').slice(0, 58)} · ${relative(checkpoint.createdAt)}</span></div>` +
        `<button class="restore" data-id="${checkpoint.id}">Restore</button></li>`,
    )
    .join('');
  list.querySelectorAll<HTMLButtonElement>('.restore').forEach((button) => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      setStatus('Opening the fragment and checking the passage…');
      const restored = await chrome.runtime.sendMessage({ type: 'DWF_RESTORE_FROM_POPUP', id: button.dataset.id });
      setStatus(restored?.ok ? 'Restore tab opened; verification is running.' : restored?.error ?? 'Restore failed.', restored?.ok ? 'ok' : 'warn');
    });
  });
}

saveButton.addEventListener('click', async () => {
  const goal = goalInput.value.trim() || 'AP Chem unit 4';
  await chrome.storage.local.set({ 'dwf:goal': goal });
  saveButton.disabled = true;
  setStatus('Saving the visible passage…');
  const reply = await chrome.runtime.sendMessage({ type: 'DWF_SAVE_CHECKPOINT_FROM_POPUP', goal });
  saveButton.disabled = false;
  if (reply?.ok) {
    setStatus(`Saved “${reply.checkpoint.anchor.slice(0, 60)}”.`, 'ok');
    await refresh();
  } else {
    setStatus(reply?.error ?? 'Could not save.', 'warn');
  }
});

copyId.addEventListener('click', async () => {
  const id = chrome.runtime.id;
  try {
    await navigator.clipboard.writeText(id);
    copyId.textContent = 'Copied';
  } catch {
    copyId.textContent = id;
  }
});

goalInput.addEventListener('change', () => {
  void chrome.storage.local.set({ 'dwf:goal': goalInput.value.trim() });
});

void refresh();
