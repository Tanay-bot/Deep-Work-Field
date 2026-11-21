declare const chrome: any;
import type { RestoreStatus } from '../../shared/src/session';

interface PopupCheckpoint {
  id: string;
  anchor: string;
  problemId: string;
  title: string;
  url: string;
  docId?: string;
  createdAt: number;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const goalInput = $<HTMLInputElement>('goal');
const primary = $<HTMLButtonElement>('primary');
const secondary = $<HTMLButtonElement>('secondary');
const status = $('status');
const list = $('list');
const shot = $<HTMLInputElement>('shot');
const latestBox = $('latest');

type Kind = 'ok' | 'warn' | 'muted' | 'busy';
function setStatus(text: string, kind: Kind = 'muted'): void {
  status.textContent = text;
  status.dataset.kind = kind;
}

function relative(ts: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
const pageOf = (url: string) => {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
};

let latest: PopupCheckpoint | null = null;
let onSavedPage = false;

function describeResult(last: any): void {
  if (!last) return;
  const map: Partial<Record<RestoreStatus, [string, Kind]>> = {
    restoring: ['Restore tab opened; checking the passage…', 'busy'],
    verified: [`Verified: back at your place${last.landing === 'dom-scroll' ? ' (landed by the extension’s scroll)' : ''}.`, 'ok'],
    ambiguous: ['Multiple matching passages on that page, so none was picked. Saved context is shown there.', 'warn'],
    'saved-context': [`Could not verify (${last.reason}); saved context is shown on the page.`, 'warn'],
    cancelled: ['The restore tab was closed before it was checked.', 'muted'],
  };
  const hit = map[last.status as RestoreStatus];
  if (hit && Date.now() - (last.at ?? 0) < 10 * 60 * 1000) setStatus(hit[0], hit[1]);
}

/** Asks for one site's access (must run straight from the click). */
function requestSite(url: string | undefined): Promise<boolean> {
  try {
    const u = new URL(url ?? '');
    if (!/^https?:$/.test(u.protocol)) return Promise.resolve(true);
    return chrome.permissions.request({ origins: [`${u.origin}/*`] }).catch(() => false);
  } catch {
    return Promise.resolve(true);
  }
}

async function restore(id: string, url?: string): Promise<void> {
  const allowed = await requestSite(url);
  if (!allowed) {
    setStatus('Without access to that site the restore cannot be verified, so it was not started.', 'warn');
    return;
  }
  primary.disabled = true;
  setStatus('Opening your place and checking the passage…', 'busy');
  const reply = await chrome.runtime.sendMessage({ type: 'DWF_RESTORE_FROM_POPUP', id });
  primary.disabled = false;
  if (!reply?.ok) setStatus(reply?.error ?? 'Restore failed.', 'warn');
}

async function save(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const allowed = await requestSite(tab?.url);
  const goal = goalInput.value.trim() || 'AP Chem unit 4';
  await chrome.storage.local.set({ 'dwf:goal': goal, 'dwf:screenshot': shot.checked });
  primary.disabled = true;
  secondary.disabled = true;
  setStatus('Saving the passage you selected…', 'busy');
  const reply = await chrome.runtime.sendMessage({ type: 'DWF_SAVE_CHECKPOINT_FROM_POPUP', goal, screenshot: shot.checked });
  primary.disabled = false;
  secondary.disabled = false;
  if (reply?.ok) {
    setStatus(
      allowed
        ? `Saved “${reply.checkpoint.anchor.slice(0, 60)}”.`
        : `Saved “${reply.checkpoint.anchor.slice(0, 40)}”, but restores here cannot be verified until you allow this site.`,
      allowed ? 'ok' : 'warn',
    );
    await refresh(false);
  } else {
    setStatus(reply?.error ?? 'Could not save.', 'warn');
  }
}

async function refresh(showResult = true): Promise<void> {
  const stored = await chrome.storage.local.get(['dwf:goal', 'dwf:lastResult', 'dwf:screenshot']);
  goalInput.value = stored['dwf:goal'] ?? 'AP Chem unit 4';
  shot.checked = stored['dwf:screenshot'] === true;
  let reply: any = null;
  try {
    reply = await chrome.runtime.sendMessage({ type: 'DWF_LIST_FROM_POPUP' });
  } catch {
    reply = null;
  }
  const checkpoints: PopupCheckpoint[] = reply?.checkpoints ?? [];
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  latest = checkpoints[0] ?? null;
  // Chrome's PDF viewer is not DOM: offer the bundled viewer instead.
  const isPdf = !!tab?.url && /^(https?|file):/.test(tab.url) && /\.pdf$/i.test(new URL(tab.url).pathname);
  const openPdf = $<HTMLButtonElement>('open-pdf');
  openPdf.hidden = !isPdf;
  openPdf.onclick = () => {
    // The viewer fetches the PDF, so it needs that one site.
    void requestSite(tab.url).then((ok) => {
      if (!ok) {
        setStatus('The viewer needs access to that site to load the PDF.', 'warn');
        return;
      }
      void chrome.tabs.update(tab.id, { url: chrome.runtime.getURL(`pdf/viewer.html?file=${encodeURIComponent(tab.url)}`) });
      window.close();
    });
  };
  onSavedPage = !!latest && !!tab?.url && pageOf(tab.url) === pageOf(latest.url);

  if (latest) {
    latestBox.hidden = false;
    $('latest-anchor').textContent = latest.anchor;
    $('latest-meta').textContent = `${latest.title} · saved ${relative(latest.createdAt)}`;
  } else {
    latestBox.hidden = true;
  }
  // Elsewhere with a saved place → the main action is returning to it.
  if (latest && !onSavedPage) {
    primary.textContent = `Return to ${latest.problemId}`;
    secondary.hidden = false;
  } else {
    primary.textContent = 'Save this passage';
    secondary.hidden = true;
  }

  const rest = checkpoints.slice(1, 9);
  list.innerHTML = rest.length
    ? rest
        .map(
          (c) =>
            `<li><div class="grow"><strong>${esc(c.anchor.slice(0, 80))}</strong><span>${esc(c.title.slice(0, 60))} · ${relative(c.createdAt)}</span></div>` +
            `<button class="restore" data-id="${esc(c.id)}">Return</button></li>`,
        )
        .join('')
    : '<li class="empty">No other saved places.</li>';
  list.querySelectorAll<HTMLButtonElement>('.restore').forEach((b) =>
    b.addEventListener('click', () => void restore(b.dataset.id ?? '', checkpoints.find((c) => c.id === b.dataset.id)?.url)),
  );
  if (showResult) describeResult(stored['dwf:lastResult']);
}

primary.addEventListener('click', () => {
  if (latest && !onSavedPage) void restore(latest.id, latest.url);
  else void save();
});

const everywhere = $<HTMLInputElement>('everywhere');
void chrome.permissions.contains({ origins: ['<all_urls>'] }).then((has: boolean) => (everywhere.checked = has));
everywhere.addEventListener('change', () => {
  if (everywhere.checked) {
    void chrome.permissions.request({ origins: ['<all_urls>'] }).then((ok: boolean) => (everywhere.checked = ok));
  } else {
    void chrome.permissions.remove({ origins: ['<all_urls>'] });
  }
});
secondary.addEventListener('click', () => void save());
shot.addEventListener('change', () => void chrome.storage.local.set({ 'dwf:screenshot': shot.checked }));
goalInput.addEventListener('change', () => void chrome.storage.local.set({ 'dwf:goal': goalInput.value.trim() }));
$('ext-id').textContent = chrome.runtime.id;
chrome.storage.onChanged.addListener((changes: any) => {
  if (changes['dwf:lastResult']) describeResult(changes['dwf:lastResult'].newValue);
});

void refresh();
