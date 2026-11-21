/**
 * Deep Work Field PDF route. Chrome's built-in PDF viewer is not DOM, so PDFs
 * open here instead: PDF.js renders each page with a real text layer, and the
 * same capture (exact selection) and verification (unique context match, in
 * view) code used for web pages runs on that text layer. Restores reuse the
 * worker's per-tab restore operations.
 */
import * as pdfjs from 'pdfjs-dist';
import type { Checkpoint, VerifyResult } from '../../shared/src/types';
import { captureCheckpointFromRange } from '../../shared/src/checkpoint';
import { verifyCheckpointAsync } from '../../shared/src/verify';

declare const chrome: any;

pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf/pdf.worker.min.mjs');

const params = new URLSearchParams(location.search);
const file = params.get('file') ?? '';
const pagesHost = document.getElementById('pages')!;
const status = document.getElementById('status')!;
const MAX_PAGES = 80;

function setStatus(text: string, kind: 'ok' | 'warn' | 'muted' = 'muted'): void {
  status.textContent = text;
  status.dataset.kind = kind;
}

async function render(): Promise<number> {
  document.getElementById('file')!.textContent = file;
  const doc = await pdfjs.getDocument({ url: file }).promise;
  const count = Math.min(doc.numPages, MAX_PAGES);
  const width = Math.min(900, window.innerWidth - 24);
  for (let n = 1; n <= count; n++) {
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: width / base.width });
    const host = document.createElement('section');
    host.className = 'page';
    host.dataset.pageNumber = String(n);
    host.style.width = `${viewport.width}px`;
    host.style.height = `${viewport.height}px`;
    const canvas = document.createElement('canvas');
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    host.appendChild(canvas);
    const layer = document.createElement('div');
    layer.className = 'textLayer';
    layer.style.setProperty('--scale-factor', String(viewport.scale));
    layer.style.setProperty('--total-scale-factor', String(viewport.scale));
    host.appendChild(layer);
    pagesHost.appendChild(host);
    await page.render({ canvasContext: canvas.getContext('2d')!, viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined }).promise;
    await new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: layer, viewport }).render();
    // Line ends are <br> elements; give the text index a real space there so
    // "reagent" and the next line's "A" do not fuse into one word.
    layer.querySelectorAll('br').forEach((br) => br.before(document.createTextNode(' ')));
    layer.querySelectorAll('span').forEach((span) => span.after(document.createTextNode(' ')));
  }
  return doc.numPages;
}

function pageOf(node: Node | null): HTMLElement | null {
  const el = node?.nodeType === 1 ? (node as Element) : node?.parentElement;
  return (el?.closest('.page') as HTMLElement | null) ?? null;
}

async function save(): Promise<void> {
  const selection = getSelection();
  const range = selection && !selection.isCollapsed && selection.rangeCount ? selection.getRangeAt(0) : null;
  if (!range) {
    setStatus('Select the problem’s heading on the page first, then press Save.', 'warn');
    return;
  }
  const page = pageOf(range.startContainer);
  const goal = (await chrome.storage.local.get('dwf:goal'))['dwf:goal'] ?? '';
  const checkpoint = captureCheckpointFromRange(document, range, { goal });
  if (!checkpoint || !page) {
    setStatus('That selection could not be mapped to the PDF’s text layer, so nothing was saved.', 'warn');
    return;
  }
  // The page number is stable structural evidence: it breaks ties between
  // identical passages, and it is where the restore scrolls first.
  checkpoint.selectorHint = `[data-page-number="${page.dataset.pageNumber}"]`;
  checkpoint.url = `${location.origin}${location.pathname}?file=${encodeURIComponent(file)}`;
  checkpoint.docId = file;
  checkpoint.title = `${decodeURIComponent(file.split('/').pop() ?? 'PDF')} · page ${page.dataset.pageNumber}`;
  checkpoint.fragment = undefined;
  const reply = await chrome.runtime.sendMessage({ type: 'DWF_SAVE_PDF_CHECKPOINT', checkpoint });
  setStatus(reply?.ok ? `Saved “${checkpoint.anchor.slice(0, 60)}” on page ${page.dataset.pageNumber}.` : reply?.error ?? 'Could not save.', reply?.ok ? 'ok' : 'warn');
}

function markLanding(range: Range | undefined): void {
  document.querySelectorAll('.mark').forEach((m) => m.remove());
  const page = pageOf(range?.startContainer ?? null);
  if (!range || !page) return;
  page.classList.add('landed');
  const pr = page.getBoundingClientRect();
  for (const r of Array.from(range.getClientRects())) {
    const mark = document.createElement('div');
    mark.className = 'mark';
    mark.style.left = `${r.left - pr.left}px`;
    mark.style.top = `${r.bottom - pr.top + 1}px`;
    mark.style.width = `${r.width}px`;
    page.appendChild(mark);
  }
}

async function verifyPending(): Promise<void> {
  let pending: any = null;
  for (let attempt = 0; attempt < 5 && !pending?.checkpoint; attempt++) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 250));
    pending = (await chrome.runtime.sendMessage({ type: 'DWF_GET_PENDING' }).catch(() => null))?.pending ?? null;
  }
  if (!pending?.checkpoint) return;
  const checkpoint: Checkpoint = pending.checkpoint;
  if (checkpoint.selectorHint) document.querySelector(checkpoint.selectorHint)?.scrollIntoView({ block: 'start' });
  const result: VerifyResult = await verifyCheckpointAsync(document, checkpoint, { attempts: 10, retryMs: 250, scrollAfter: 1 });
  const { range, ...plain } = result;
  await chrome.runtime.sendMessage({ type: 'DWF_VERIFY_RESULT', checkpointId: checkpoint.id, restoreId: pending.restoreId, result: plain }).catch(() => undefined);
  if (result.ok) {
    markLanding(range);
    setStatus(`Verified · “${checkpoint.anchor.slice(0, 60)}” on ${checkpoint.title.split(' · ').pop()}.`, 'ok');
  } else {
    const why =
      result.reason === 'ambiguous'
        ? 'Multiple matching passages in this PDF, so none was picked.'
        : result.reason === 'no-match' || result.reason === 'context-mismatch'
          ? 'The saved passage was not found with the same surrounding text (the PDF may have changed).'
          : 'The passage could not be brought into view.';
    setStatus(`Saved context only · ${why} Saved: “${checkpoint.anchor}”.`, 'warn');
  }
}

document.getElementById('save')!.addEventListener('click', () => void save());

if (!file) {
  setStatus('No PDF given. Open a PDF tab, then use “Open in PDF viewer” from the Deep Work Field popup.', 'warn');
} else {
  render()
    .then((total) => {
      setStatus(total > MAX_PAGES ? `Showing the first ${MAX_PAGES} of ${total} pages. Select a passage and press Save.` : 'Select a passage and press Save.');
      return verifyPending();
    })
    .catch((error) => setStatus(`This PDF could not be opened (${error?.message ?? error}). file:// PDFs need “Allow access to file URLs” for the extension.`, 'warn'));
}
