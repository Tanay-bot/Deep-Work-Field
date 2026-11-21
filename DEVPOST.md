# Devpost copy (matches what is shipped)

Keep this file in sync with the README's "What is stubbed / not shipped" section. Every sentence
below is true of the code on `main`.

## Inspiration

Coming back to homework is the expensive part. You look up, you were on a problem, and now you are
scrolling a 12-page worksheet trying to find where you were — or you land on the answer key that has
the same heading.

## What it does

Deep Work Field helps students return to the exact problem they left. Start a study session and a
floating galaxy shows your focus state. When the app detects likely drift, an optional spoken nudge
says where you were ("You were on 4b, limiting reagent"), and **Resume** reopens that passage.

Resume is **verified**: the app finds every place on the page with the same heading, keeps only the
one whose surrounding text matches what you saved, and only says "Verified" when exactly one passage
matches and it is on screen. If two places match, it says "Multiple matching passages". If nothing
can be verified, it says "Saved context only" and shows what it saved. It never claims a restore it
did not check.

Three modes share the same checkpoint and restore code: **Resume-only**, **screen-only nudges**, and
**full fusion** with correction memory. You can correct any call in the replay; corrections are stored
locally and can override later calls only on a 4-of-5 supermajority.

## How we built it

- **Chrome extension (Manifest V3)** saves the exact passage you select (mapped to a position in the
  page text, with the words before and after it), opens a scroll-to-text link that Chrome itself
  lands, then verifies the landing in the page. Each restore is its own operation with an ID, so two
  restores can never be confused.
- **Web app (Vite + TypeScript)** runs the focus engine: a temporal model with FOCUSED / WRITING /
  DRIFTING / UNCERTAIN, a 3-second drift hold that restarts if evidence stops arriving, one nudge per
  drift episode, and a live decision trace.
- **Live screen mode**: with the extension, the visible text of your active tab streams to the
  focus engine once a second (only during a session, never off the device). Goal matching combines
  how many of your goal's terms are on screen, an on-device **Transformers.js** sentence model
  (MiniLM) that catches near-topic pages like a stoichiometry lecture, and "this is the page you
  saved".
- **On-device text similarity** for correction memory uses a small local hashed embedder (no model
  download, no network).
- **Face cues**: MediaPipe Face Landmarker runs in the page (no frames stored or sent). A two-pose
  calibration — look at the screen, then at your notes — defines "head down" for you, so writing on
  paper reads as WRITING, not drift.
- **Voice** uses the browser's on-device speech synthesis.
- **Galaxy** is a WebGL2 shader point cloud whose four shapes morph on the GPU with the focus state,
  plus a Document Picture-in-Picture mini-galaxy.
- **Planner**: a focus-by-hour curve from your live sessions suggests deep-work blocks.
- **Tests**: `npm test` runs 13 checks in Chromium (duplicate headings, identical-context ambiguity,
  selection capture, inline markup, Unicode, Chrome's native fragment landing, engine timing);
  `tools/extension-e2e.mjs` loads the unpacked extension and runs two restores at once.

## Challenges

Two problems can share a heading, and a resize can move both. Saving the surrounding text is not
enough on its own: Chrome's scroll-to-text only accepts context that sits inside one paragraph, so
the app stores two versions — long context for its own verifier, block-local context for the URL —
and records whether Chrome or the app's single fallback scroll put the passage on screen.

## What's honest to say

- "Verified restore on supported worksheets." "Works offline on cached pages."
- "Learns from your corrections", not "learned my focus".
- The hosted zero-install demo drives the focus engine with **labelled scripted signals**; live
  mode (real tabs) needs the extension; Full fusion live also needs the camera.
- Face cues are real (MediaPipe) but have only been tested with a fake camera in CI and by hand —
  not measured on a study group. Head pose is a proxy for attention.
- Kokoro voice, OCR and the PDF route are **not shipped** in this build.
- Text fragments do not work inside Google Docs (saved context only there).
- The evaluation study has not been run with students yet; any numbers shown are a pilot. Main metric
  when it is run: "time to first qualifying answer edit".
- Built during the event with AI coding help.

## Try it

- Hosted demo: _your deployed URL_ → **Try the 4b demo** (no install).
- Extension: **Get the extension** on the site → download the zip → `chrome://extensions` →
  Developer mode → Load unpacked → pick the `deep-work-field-extension` folder. It connects
  automatically (fixed extension ID).
