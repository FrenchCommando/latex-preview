# Project notes

Non-obvious decisions that would otherwise be hard to reverse-engineer.

## Scope

Personal, single-purpose extension: live-preview the active `.tex` file's PDF
in a side panel. Deliberately minimal — no syntax features, no SyncTeX, no
zoom controls. If it grows toward "general LaTeX IDE" territory, push back —
that's LaTeX Workshop's job. Project-specific knowledge (main file, figure
pipeline) lives in each consumer's `latex-preview.json`, not in code.

## Build & install

End-user flow is `npm install && npm run package`, then install the `.vsix`
(or download from CI's `latest` release). No `.vscode/launch.json`; F5 is not
the workflow. To iterate on the extension itself, `npm run watch` +
repackage + reinstall.

`code --install-extension` is a no-op if the manifest `version` matches what's
already installed — VS Code says "already installed" and keeps the old bits.
So every change you want to ship needs a `package.json` version bump, even a
one-line fix. Patch-bump for fixes, minor-bump for milestones; don't worry
about strict semver pre-1.0.

## CI release

`.github/workflows/build.yml` updates a single GitHub Release tagged `latest`
on every push to `main` (PRs skip the release step). Title format is
`v<version> — <YYYY-MM-DD HH:MM UTC>` so date+version is visible at a glance
in the Releases list — explicit fix for the "commit-hash-as-release-name made
history hard to read" pattern from 2piece's `paper.yml`. The vsix is uploaded
with `--clobber` so the asset name stays `latex-preview.vsix` and the stable
URL `releases/latest/download/latex-preview.vsix` always points at the
current build.

To switch to versioned releases later, change the trigger to
`on.push.tags: 'v*'` and drop the `--clobber` / fixed-tag machinery.

## Configuration

Settings live in `latex-preview.json` at the workspace root, not VS Code
settings. The extension reads it on activate, watches it for live changes.
There's no `contributes.configuration` in `package.json`. Reason:
project-scoped knobs (figure command, main file path) belong in the project,
not in user/workspace settings. The schema at
`schemas/latex-preview.schema.json` is wired via `contributes.jsonValidation`
so the file gets IntelliSense.

## Version pins

- `typescript ^6.0.0` — TS 6 deprecated `moduleResolution: "node"`. Must use
  `node16` or `nodenext`. Revisit if downgrading TS.
- `tsconfig.json` has `"types": ["node", "vscode"]` — with `module: node16`,
  TS 6 doesn't auto-discover `@types/node`. Without this, every `node:*`
  import errors. Don't remove unless you re-test the build.
- `engines.vscode ^1.120.0` matches `@types/vscode`. Bump these together —
  the types provide the API surface for the declared engine version.
- `pdfjs-dist ^5.7.0` — see "pdf.js" section below for the build & worker
  choices.

## Bundle slimming (`.vscodeignore`)

Default `vsce package` produces a 23.5 MB vsix because `pdfjs-dist` pulls in
`@napi-rs/canvas` (Node-side canvas, useless for our webview-only usage) and
ships cmaps, fonts, types, sourcemaps, web/, image_decoders/, and both
`build/` and `legacy/build/`. The current `.vscodeignore` keeps only
`legacy/build/pdf.min.mjs`, `legacy/build/pdf.worker.min.mjs`, and LICENSE
from `pdfjs-dist`, and drops `@napi-rs/**` entirely. Result: ~536 KB.

If PDFs ever render with missing glyphs (uncommon scripts, non-Computer-
Modern fonts), re-include `cmaps/` and `standard_fonts/` and pass `cMapUrl` /
`standardFontDataUrl` to `getDocument()` in `media/preview.js`.

## pdf.js

Two non-obvious choices for which files to ship:

- **`pdfjs-dist/legacy/build/`, not `build/`.** The "modern" build calls
  `Map.prototype.getOrInsertComputed` — TC39 reached Stage 4 only in Oct 2025,
  and V8 hasn't shipped it under the final name yet (still missing on
  Chromium 142). Legacy is transpiled around this. Not optional. Revisit when
  V8 release notes explicitly list `getOrInsertComputed`.
- **`.min.mjs` variants.** Halves the bundle (~1.7 MB vs ~3.2 MB) and the
  cold-start parse time. If you ever need to debug pdf.js internals, swap
  back to non-min temporarily.

**Worker must load via a `blob:` URL.** VS Code webviews refuse to spawn an
ES-module Worker from the `vscode-webview://` URI scheme. When pdf.js tries
`new Worker(workerSrc, { type: "module" })` with our webview-served URI, the
spawn silently fails, pdf.js prints `Warning: Setting up fake worker`, and
falls back to running all parsing on the main thread — a 13-page paper goes
from ~500 ms to ~30 s.

Workaround in `media/preview.js`: `fetch` the worker source as text, wrap in
a `Blob`, get a `blob:` URL via `URL.createObjectURL`, set that as
`GlobalWorkerOptions.workerSrc`. Browsers allow workers from `blob:` URLs
even when other schemes are restricted.

The CSP needs **both** of:

- `worker-src {{CSP_SOURCE}} blob:` — for the worker spawn.
- `connect-src {{CSP_SOURCE}}` — without this, `fetch()` falls back to
  `default-src 'none'` and is blocked. Easy to forget; symptom is a CSP
  violation on the fetch URL in the webview console.

Also: assign `pdfjs` to the global **only after** `workerSrc` is configured.
The message handler gates on `if (pdfjs)`; if `pdfjs` is set immediately
after `await import()` but before the fetch+blob completes, a "load" message
arriving in that window calls `renderPdf` and throws
`No "GlobalWorkerOptions.workerSrc" specified`. Hold the imported module in
a local until the worker is wired up.

## Compile triggers & gates

The compile pipeline is gated to avoid wasted work and to react in the right
order:

- **Trigger is `onDidSaveTextDocument`**, not `onDidChangeTextDocument`. The
  LaTeX driver reads from disk; recompiling on every keystroke would target
  the stale on-disk bytes. Auto-save users still get near-live preview
  because auto-save fires a save event after each idle pause.
- **Visibility gate.** Auto-compile only runs when the preview panel exists
  AND is visible. A hidden preview tab pauses; switching back triggers a
  catch-up via the `pendingWhileHidden` flag. Manual **Compile Now**
  bypasses both gates.
- **Figure regen is lazy.** `figureWatch` globs set `figuresStale = true`;
  the next compile runs `figureCommand` first if dirty, then the LaTeX
  driver. A watched-file save also schedules a compile directly (same
  visibility gate as `.tex` saves), so editing a figure source updates the
  preview without needing to touch a `.tex`.
- **Stale-PDF prewarm.** `showPreview` reads any existing `<mainFile>.pdf`
  from disk and dispatches it before kicking off the fresh compile. Hides
  ~5–15 s of MiKTeX cold-start on the first compile per session. Falls
  through silently if no PDF exists yet.

## Lazy page rendering

`media/preview.js` renders in two passes:

1. Synchronously create blank canvases sized via `page.getViewport()` for
   every page, swap into the container in one shot. Layout and scroll
   position settle immediately.
2. An `IntersectionObserver` (rootMargin 400 px) renders each page's actual
   content when (or just before) it enters the viewport.

For a 13-page paper the user sees the first ~3 pages within ~500 ms instead
of waiting ~3–4 s for all pages to render serially. Scrolling rapidly may
show a blank canvas for a frame before its content paints — acceptable
tradeoff. The observer is disconnected on each new render to avoid
callbacks firing against detached canvases.

## Preview modes: `compile` vs `static`

`previewMode` in `src/extension.ts` defaults to `"compile"` and flips to
`"static"` after **Open PDF**. The mode gates the `.tex` save listener and
the figure-watch markStale callback — both early-return when not in compile
mode. Reason: opening a plain PDF (build artifact, unrelated document)
shouldn't be silently overwritten by the latest paper build the next time
you save a `.tex`.

Flip back to `compile` happens via four triggers:

- **Show** — explicit; also reveals + compiles.
- **Saving a `.tex`** — the clearest "intent to compile" signal. Flips mode
  and proceeds with the normal compile flow. Without this, the save would
  be silently dropped in static mode, which is the worst kind of
  surprise.
- **Focusing a `.tex` editor** (`onDidChangeActiveTextEditor`) — catches
  the "click back on the .tex tab" path. Flips mode AND reloads the
  compiled `<mainFile>.pdf` so the swap is immediately visible.
- **Cursor / selection change in a `.tex`** (`onDidChangeTextEditorSelection`)
  — catches the path where the user never lost focus from the `.tex`
  (e.g., explorer right-click → openPdf with the editor still active).
  Gated by `STATIC_MODE_GRACE_MS` (1 s) so a cursor still in the `.tex`
  at the moment of `openPdf` doesn't immediately revert the mode the
  user just chose.
- **Panel disposal** — closing the preview resets to compile for the
  next session.

Combined, these cover every realistic way a user returns to the `.tex`
without being aggressive enough to undo the user's `openPdf` intent.

## Tab-context menu wiring

The `editor/title/context` entry for `latexPreview.compile` is gated on
`when: "activeWebviewPanelId == latexPreview"`. The string `latexPreview`
must match the **first argument** of `createWebviewPanel` (the `viewType`)
in `src/preview.ts`. Renaming the viewType silently breaks the menu entry —
no error, it just stops appearing. Same contract for any future tab-context
entries.
