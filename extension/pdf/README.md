# PDF route

`viewer.html` + `../src/pdf.ts` (bundled as `pdf/pdf.js` by `extension/build.mjs`, with PDF.js's
worker and `pdf_viewer.css` copied from `pdfjs-dist`).

- Chrome's built-in PDF viewer is not DOM, so the popup offers to reopen a PDF tab here.
- Each page renders to a canvas plus a PDF.js text layer. Line-end `<br>`s and span boundaries get a
  space so words on adjacent lines do not fuse in the text index.
- **Save** uses `captureCheckpointFromRange` on the selection; the checkpoint stores the viewer URL,
  the PDF URL as `docId`, and `[data-page-number="N"]` as the tie-breaking hint.
- **Restore** reopens the viewer; it asks the worker for its pending restore (same per-tab
  `restoreId` operations as web pages), scrolls to the page, runs `verifyCheckpointAsync`, and draws
  the amber rule under the verified passage, or shows "Saved context only".
- Checked by `tools/extension-e2e.mjs` with `tools/fixtures/worksheet-a.pdf` (two identical 4b
  headings): saved on page 2 and verified back on page 2.
