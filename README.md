# Deep Work Field

Your study session drifted. One click takes you back to problem 4b.

On-device study companion for Chrome: set a session goal, let the galaxy show focus live, get a
spoken nudge that names the exact problem you left, and resume it with a scroll-to-text fragment
that is **verified against the surrounding passage and the viewport**. If the check fails, the app
says “Saved context only” and shows the saved frame/text — it never claims a restore it did not verify.
Corrections are stored locally and can change later calls. No accounts, no backend, no cloud AI.

- Production demo: **https://deep-work-field-ikbno6.freebuff.site**
- Preview build: **https://deep-work-field-ikbno6-preview.freebuff.site**
- Event: TripleH (Teens Hack Houston) · Productivity · Devpost closes Nov 21, 2026, 5:00 PM CST

## Quick start

```bash
npm install
npm run dev          # http://localhost:3000 (Vite + TypeScript)
npm run build        # typecheck + production build into web/dist
npm run build:extension
```

The web build is a static Vite site; `sites/deploy.json` serves `web/dist` through a tiny Worker.
The extension build writes `extension/dist` and `extension/deep-work-field-extension.zip`.

**Chrome/Chromium is required** for text-fragment scroll and Document Picture-in-Picture. The demo
opens tabs with `window.open`, so allow popups for the site.

## Repo layout

```
/web        Vite + TypeScript app (hosted demo, goal matcher demo, galaxy, trace, corrections, study mode)
/extension  Chrome MV3 extension (service worker, content script, popup, PDF stub)
/shared     Types, checkpoint schema, config, fragment builder, verification, fusion engine, kNN
/demo       Demo worksheets, including worksheet-a.html with TWO identical “4b. Limiting reagent” headings
/sites      Worker + deployment manifest for the hosted build
/tools      results.mjs (CSV + labeler drift labels → per-student table) and sample fixtures
```

## What the demo does, exactly

1. **Try it now** opens the chemistry worksheet and captures problem 4b: URL, problem id, normalized
   anchor text, and the surrounding prefix/suffix. The tab is closed.
2. **Simulated drift** feeds a labelled script (`FOCUSED` lecture → `WRITING` head-down → off-task
   Minecraft clip) through the real fusion engine, smoothing, 3-second hold, trace, galaxy and nudge.
   The UI says “scripted demo signals”; it is not pretending to read your screen.
3. **Resume** opens the worksheet URL with a text fragment such as
   `#:~:text=…-,4b.%20Limiting%20reagent,-A%2010.0%20g…`, then verifies the matched passage with a
   TreeWalker + range and `getBoundingClientRect()`. A failed check shows “Saved context only”.
4. Typing at least 10 characters (or a newline) in the anchored answer region records the first
   qualifying edit.
5. The replay can be scrubbed through the trace. Corrections are stored in IndexedDB. Five
   neighbours with a 4-of-5 supermajority override; 3–2 becomes `UNCERTAIN` and never nudges.

The two `4b` headings exist to prove the point: the problem copy sits in Part II, the answer key copy
sits in Part III with different surrounding text. Only the checkpoint whose prefix/suffix match and
whose range is in view passes verification.

## Checkpoint / restore details

- `shared/src/fragments.ts` builds `prefix-,start,-suffix` fragments, doubling dashes and commas
  inside each term before `encodeURIComponent`.
- `shared/src/verify.ts` builds a whitespace-normalized text index with a per-character DOM map, finds
  every anchor occurrence, rejects candidates whose prefix/suffix do not match, then requires the
  matched range to intersect the viewport. It retries during Chrome’s scroll and scrolls the matched
  range itself once before returning `not-in-viewport`. This is what makes the duplicate heading safe.
- `shared/src/checkpoint.ts` captures word-aligned context and the nearest answer region.
- Extension restores use `chrome.tabs.create` with the fragment; the content script verifies on load,
  reports the result to the service worker, and shows a success pill or a “Saved context only” banner.
- Google Docs has no DOM text layer, so its landing fails verification and shows saved context. No UI
  copy claims otherwise.
- Checkpoints, sessions, traces, corrections and study recordings live in IndexedDB (web) or
  `chrome.storage.local` (extension). Nothing leaves the device.

## Engine rules (implemented in `shared/src/engine.ts`)

- States: `FOCUSED`, `DRIFTING`, `WRITING`, `UNCERTAIN`.
- On-task screen + head down = `WRITING`, not distraction.
- Conflicting evidence = `UNCERTAIN`; `UNCERTAIN` never nudges.
- A distraction is logged only after `DRIFTING` holds for `driftHoldMs` (3 s). Nudges obey the same
  hold and a cooldown.
- Every decision writes a `TraceEntry` with inputs, smoothed similarity, vote counts, reasons,
  correction votes and nudge/log flags. The decision panel and replay read the same entries.
- Correction memory: k=5 nearest corrections within a distance threshold, same goal, distance-weighted
  evidence; override only on a 4-of-5 same-label supermajority; 3–2 → `UNCERTAIN`.
- Modes: Resume-only (no detection), screen-only (screen similarity alone), full fusion. All three use
  the same checkpoint/restore functions.
- All thresholds live in `shared/src/config.ts`. Settings can **freeze thresholds**; the flag is
  persisted, blocks edits, and is recorded on each session.

## Supported content

| Content | Hosted demo (no install) | Extension |
| --- | --- | --- |
| Built-in demo worksheets | Verified restore | **Verified** end-to-end in Chromium 141 |
| Uploaded HTML worksheet | Verified restore (blob URL, processed locally) | Implemented; same DOM path, not yet verified in the extension harness |
| Pasted third-party URL | Opens the page, then “Install the extension / saved context only” screen | Implemented for DOM pages; not yet verified in the extension harness |
| Google Docs | Not supported | Saved context only |
| Native apps | Not supported | Not supported (OCR fallback not shipped) |
| Web PDFs | Not supported | Not shipped (PDF route is a stub) |

## Study mode and evaluation

Study mode records **only the tab you pick** (`getDisplayMedia({video:{displaySurface:'browser'}, audio:false})`),
so the worksheet recording has no coach audio and no galaxy overlay. If you pick a window or the whole
screen, it refuses and asks for a Chrome tab. It logs `mode`, state changes, drift timestamps, nudge
timestamps, first-qualifying-edit timestamps, restores and correction decisions to IndexedDB, records a
WebM, and downloads a CSV per session.

CSV columns: `session_id,timestamp_iso,elapsed_ms,type,state,mode,detail`.
Labeler CSV columns (independent, blind to mode): `student,session_id,drift_onset_ms`.

```bash
npm run eval -- --sessions tools/samples --labels tools/samples/labels.csv
# or
node tools/results.mjs --demo
```

The table is per student/session (never only a pooled median): duration, time to first qualifying edit
after the labeler’s drift onset, false nudges per hour (±10 s of a label counts as explained),
missed drifts, % time UNCERTAIN, never-returned episodes and correction counts. Time to first
qualifying edit is named as an edit, not verified progress. The correction counts are an
ablation-style record of decisions logged while corrections were active, not a claim of causality.

## What is stubbed / not shipped (honest scope)

- **Face cues (shipped)**: MediaPipe Face Landmarker runs on-device from `web/public/mediapipe/`
  (wasm + model served same-origin, so it works offline once cached). **Turn on camera** in the
  session's Face cues card, then calibrate: look at the screen, then at your notes; "head down" is
  defined relative to those two poses, so the matrix sign convention and camera angle don't matter.
  Detection runs on each live sample (event-driven, so background-tab timer throttling cannot stall
  it). Verified in CI only with Chromium's fake camera (model loads, reports "no face"); not yet
  measured on real students. The zero-install scripted demo still uses labelled scripted face cues.
- **Semantic goal matcher (shipped)**: all-MiniLM-L6-v2 (q8) via Transformers.js, vendored in
  `web/public/models` with the ONNX runtime in `web/public/ort`; remote model loading is disabled.
  Loaded when live mode starts (~1.7 s), ~10 ms per sample. Measured cosine to the goal "AP Chem unit
  4 limiting reagent": worksheet 0.67, a stoichiometry lecture 0.42 (0/5 goal terms, so the term
  matcher alone would miss it), AP Bio homework 0.28, Minecraft / lofi / Instagram ≈ 0. It can only
  *raise* on-task evidence; the hashed embedder still keys correction memory.
- **Kokoro HD voice (shipped, opt-in)**: **Download HD voice** fetches Kokoro-82M (q8 ONNX, ~90 MB)
  once from Hugging Face — the app's only network download, started by the user — then it runs on
  the vendored WebAssembly runtime from the browser cache, offline. Synthesis takes ~10 s on
  single-thread WASM, so the nudge line is pre-synthesized whenever the checkpoint changes and plays
  instantly (measured 0.0 s); an unprepared line falls back to the device voice immediately. Model
  loads are serialized so the semantic matcher stays local-only (`local_files_only`).
- **OCR fallback (shipped)**: **Watch another app (OCR)** shares a window or the whole screen; every
  3 s one downscaled grayscale frame is read by Tesseract.js on-device (worker, wasm core and the
  `eng` best_int model vendored in `web/public/tesseract`, ~11 MB; no CDN). The text goes through
  the same goal matcher and engine as live tabs, with source `ocr`; frames are never stored. While
  OCR runs it is the screen source and extension tab samples are ignored. Checked in Chromium on a
  rendered test card (read correctly in 2.4 s with model load) and with a fake screen share.
- **PDF route (shipped)**: on a PDF tab, the popup offers **Open this PDF in the Deep Work Field
  viewer** (`extension/pdf/viewer.html`, PDF.js). Pages render with a real text layer, so the same
  selection capture and unique-match verification run on PDFs; the page number is the tie-breaking
  hint. Restores reopen the viewer and draw the amber rule under the verified passage. First 80
  pages are rendered. `file://` PDFs need the extension's "Allow access to file URLs".
- **Planner (shipped)**: focus-by-hour curve from saved *live* sessions only (scripted demo samples
  are excluded); an hour is suggested only after ~30 minutes of decided samples.
- **Capybara constellation (shipped)**: type `capybara` anywhere outside a text field.
- **Narrow site access (shipped)**: the extension asks for **no site access at install**
  (`host_permissions: []`, `optional_host_permissions: ["<all_urls>"]`). Saving or returning to a
  passage asks for that one site from the popup; the content script is then registered only for
  approved sites and injected on demand (activeTab) where you invoke it. Live mode reads full
  visible text only on approved sites and otherwise uses the tab title (from the `tabs`
  permission). An opt-in popup switch grants every site. `tools/extension-noperm-e2e.mjs` checks the
  shipped build nudges from titles with zero site access; `tools/extension-e2e.mjs` runs against a
  `DWF_E2E=1` build that pre-grants access (headless Chrome cannot click the permission prompt).
- **Fixed extension ID**: `manifest.json` carries a public `key`, so every unpacked install has the
  ID `ebcoijhkmohgagkgkaaafhjkffcjcchn` and the web app connects without pasting anything. The site's
  origin must still be listed in `externally_connectable`.
- **Live screen path (shipped)**: with the extension installed, **Use my real screen** opens a port
  to the extension, which streams the *visible* text of the active tab once a second (only while a
  session listens, only from the visible tab; restricted pages are reported by title). The web app
  scores it with goal-term coverage plus "this is the page you saved" and runs the same focus engine
  and trace. Screen-only mode nudges on real tabs; full fusion still needs face cues.
- **Data**: no accounts, backend, analytics, or network calls for detection (the optional HD-voice
  download is the one user-initiated network fetch). The hosted page does use a
  service worker for offline assets.

## Offline

`web/public/sw.js` precaches the shell and both demo worksheets and runtime-caches same-origin assets.
The production build registers it; the hosted Worker rewrites `.html` paths to avoid Cloudflare’s
pretty-URL 307 so precache succeeds. The opening-shot sequence was tested with the browser offline:
load → Try it now → capture → close tab → drift → nudge → Resume → verified restore, all without
network.

## Extension install

1. Download `deep-work-field-extension.zip` from the hosted site (**Get the extension**) or from
   `web/public/` in this repo — or build it: `npm install && npm run build:extension`.
2. Unzip it; it contains one folder, `deep-work-field-extension/` (or use `extension/dist`).
3. `chrome://extensions` → Developer mode → **Load unpacked** → select the folder with `manifest.json`.
4. Return to the web app; it connects on its own (fixed ID). The ID field is only under **Advanced**.
5. On a worksheet tab, select the passage or scroll to the heading, open the popup, set the goal and
   press **Save checkpoint on this tab**. **Restore** opens a new tab with the fragment; the content
   script verifies it and shows either “Verified restore” or “Saved context only”.

`externally_connectable` currently lists localhost:3000, `*.style.dev`, the preview URL and the
production URL. Add any custom domain there before using the bridge.

### Automated checks

```bash
npm test                      # 13 Chromium checks on shared/ capture, verify, fragments, engine
npm run build:extension && npm run dev   # then, in another shell:
DWF_E2E=1 npm run build:extension && node tools/extension-e2e.mjs   # full extension flow (site access pre-granted)
npm run build:extension && node tools/extension-noperm-e2e.mjs      # shipped build, no site access
```

`npm test` covers: the twin-4b worksheet (never the answer key), a harder fixture where heading
**and** surrounding lines are identical (must report `ambiguous`, never pick by visibility), a saved
problem id breaking that tie, selecting the 2nd of two repeated phrases, a word split by inline
markup and a multi-node selection, hidden ancestors, length-changing case folding (İ, ß), spec-correct
fragment encoding with an app hash kept, a sampling gap that must restart the 3 s drift hold, and one
nudge per drift episode.

Restore guarantees enforced by the code:

- **Unique match or nothing.** Every occurrence whose anchor, prefix and suffix match is collected
  first. A saved problem container may break a tie; viewport position never does. Still tied →
  `ambiguous` ("Multiple matching passages"), treated as a failure.
- **Landing is recorded.** `landing: native` means the browser/page put the passage in view;
  `dom-scroll` means the app's single fallback scroll did (it scrolls at most once).
- **Selection capture** maps the selected range's endpoints into the text index; an unmappable
  selection is refused, never swapped for another occurrence.
- **One operation per restore.** The extension opens a blank tab, registers `{restoreId, tabId}`,
  then navigates. Replies must carry the matching `restoreId`; stale ones are ignored. Restores time
  out after 60 s and are cancelled when their tab closes. Checkpoint writes are serialized.
- **First edit** is measured from the answer field's value at restore time, in the field inside the
  verified passage's container; if none can be linked the metric is reported unavailable.
- **Correction memory** may always suppress a drift, but may only create one from an UNCERTAIN call
  with a present face; the trace records the provisional call separately.

### Extension end-to-end check

The built zip was unzipped and loaded into full Chromium 141.0.7390.37 (Playwright, headless) with
`--disable-extensions-except` / `--load-extension`. The popup's own **Save** and **Restore** buttons
were clicked; the service worker, content script, text-fragment tab and storage were all exercised:

- selected Part II **4b. Limiting reagent** on the demo worksheet and saved it from the popup;
- closed the worksheet tab and restored from the popup: the new tab carried the prefix/suffix text
  fragment, the content script verified the **problem** 4b (not the answer-key twin), 4b was in the
  viewport at `scrollY 1008`, and `4b-key` was offscreen at `top 1727`;
- the first qualifying edit in the 4b answer was recorded (`problemId: 4b`, 82 chars);
- corrupting the saved anchor produced the **Saved context only** banner after 14 attempts, with no
  false verified claim.

This is a headless Chromium run. The `chrome://extensions` **Load unpacked** click and the browser
**toolbar popup** were not automated: the unpacked folder was loaded with the equivalent
`--load-extension` flag, and `popup.html` was opened directly as an extension page. A normal desktop
Chrome toolbar popup uses the same page and handlers, but that final browser-UI click is not claimed
as tested.

## Checks run before the 3:45 PM freeze

| # | Check | Result |
| --- | --- | --- |
| 1 | Fresh browser storage → deployed link → Try it now → drift → nudge → Resume loop, no install | **PASS** on both the public preview and the published production URL: capture, 3 s hold, spoken/banner nudge, verified landing, first qualifying edit. Verified with Playwright on a new origin (not a brand-new desktop Chrome profile). |
| 2 | Extension loads unpacked from the zip using README steps alone | **PASS (headless Chromium 141, equivalent load)**: built zip unzipped and loaded with `--load-extension`; service worker started, popup Save and Restore clicked. Saved Part II 4b, closed the tab, restored to 4b with the answer key offscreen, logged the first 4b edit, and showed Saved context only for a corrupted anchor. The `chrome://extensions` UI click and actual toolbar popup were not automated; `popup.html` was opened directly. |
| 3 | Two identical “4b” headings + resize → restore lands on the right one and verification passes | **PASS**: both headings present; restore at 480×720 during navigation landed on Part II, answer key offscreen, status “Verified restore… Landed on the Part II problem 4b, not the answer key.” |
| 4 | Unsupported URL → install extension / saved context only screen | **PASS**: third-party URL opens, dialog shows “The hosted demo cannot verify here” and “Saved context only”. |
| 5 | Wi-Fi off → opening-shot sequence end to end | **PASS** on the preview (same build): service worker controlled the page; offline shell, worksheet, capture, nudge and verified resume all completed. |
| 6 | 3–2 vote shows UNCERTAIN; a correction changes a later similar call | **PASS**: 3 on-task / 2 drift → trace state `UNCERTAIN` with votes 3–2 and no nudge; 5/5 on-task → later similar call shown as `FOCUSED` with “Correction memory override: 5/5”. |

Also exercised: uploaded-HTML capture + blob-URL verified restore, study recording with a synthetic
display stream (CSV auto-download, WebM blob, IndexedDB record), Document PiP request, threshold freeze,
and graceful “recording was not started” UI when screen capture is denied.

Not verified here: the actual toolbar popup and a full desktop Chrome profile (the extension run used
headless Chromium 141 with `popup.html` opened directly), real MediaPipe/Kokoro model startup, and real
student evaluation sessions. The evaluation script was run on the sample fixtures.

## Development notes

- `npm run typecheck` — strict TypeScript over web, shared and extension.
- `npm run build` — typecheck then Vite build.
- `npm run dev` — dev server on `0.0.0.0:3000`; the `/demo` worksheets are served by a small Vite
  middleware and copied into `web/dist/demo` for production.
- The galaxy is a WebGL2 shader point cloud (three.js `ShaderMaterial`): each focus state is a
  precomputed shape stored as a vertex attribute, and the GPU morphs between them from four eased
  blend weights. Particle count adapts when frames exceed 20 ms.
- UI motion (intro, reveals, magnetic buttons, cursor) lives in `web/src/lib/fx.ts` (GSAP) and is
  presentation-only; it is disabled under `prefers-reduced-motion`. Fonts are bundled via Fontsource,
  so the app works offline once cached.
- Document PiP must be opened by the PiP button (user gesture); when unavailable it shows the in-page
  mini panel.
