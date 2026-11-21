# PDF route (stubbed)

This directory is a deliberate Phase 6 stub, not a working PDF viewer. The
Devpost build ships Phases 1–5; the plan explicitly says not to start the PDF
route, OCR fallback or planner until those work end to end.

What a real implementation needs (and what is missing here):

1. `pdfjs-dist` bundled into the extension, with its worker and the viewer page
   listed in `web_accessible_resources`.
2. A page/region checkpoint schema: document hash, page number, normalized
   text-layer anchor, and prefix/suffix within that page's text layer.
3. Restore via the bundled viewer, not Chrome's native PDF viewer: open the PDF
   as an extension page (`/pdf/viewer.html?file=<url>&anchor=...`), render the
   page, then verify the anchor against the text layer and scroll the canvas to
   the region. Native PDF pages are not DOM and cannot be text-fragment
   restored.
4. A saved-context frame per PDF page, plus the same "Saved context only"
   failure path used by the HTML route.

The viewer page in this folder only states that the route is absent. The app's
supported-content table and README say the same thing, so no UI copy claims PDF
support that does not exist.
