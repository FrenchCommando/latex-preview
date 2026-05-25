# Project notes

Non-obvious decisions that would otherwise be hard to reverse-engineer.

## Scope

Personal, single-purpose extension: live-preview the active `.tex` file's PDF
in a side panel. Deliberately minimal — no syntax features, no SyncTeX, no zoom
controls in v1. If it grows toward "general LaTeX IDE" territory, push back —
that's LaTeX Workshop's job, not this. Project-specific knowledge (main file,
figure pipeline) lives in each consumer's `latex-preview.json`, not in code.

## Why not the VS Code dev host?

End-user flow is `npm install && npm run package`, then install the `.vsix`.
There's no `.vscode/launch.json`; F5 is not the intended workflow. If you want to
iterate on the extension itself, do `npm run watch`, repackage, and reinstall.

## Settings live in `latex-preview.json`, not VS Code settings

The extension reads `latex-preview.json` from the workspace root and watches it
for live changes. There's no `contributes.configuration` in `package.json`.
Reason: project-scoped knobs (figure command, main file path) belong in the
project, not in user/workspace settings. Schema at `schemas/latex-preview.schema.json`
is wired via `contributes.jsonValidation` so the file gets IntelliSense.

## Version pins

- `typescript ^6.0.0` — TS 6 deprecated `moduleResolution: "node"`. Must use
  `node16` or `nodenext`. Revisit if downgrading TS.
- `tsconfig.json` has `"types": ["node", "vscode"]` — with `module: node16`,
  TS 6 doesn't auto-discover `@types/node`. Without this, every `node:*` import
  errors. Don't remove unless you also re-test the build.
- `engines.vscode ^1.120.0` matches the `@types/vscode` we installed. Keep
  these two in lockstep — `@types/vscode` provides API surface for the
  engine version, so they should always bump together.
- `pdfjs-dist ^5.7.0` — uses ESM (`pdf.mjs` + `pdf.worker.mjs`). The webview
  dynamic-imports them at runtime. Two non-obvious choices here:
  - **We use `pdfjs-dist/legacy/build/`, not `build/`**, even though the latter
    sounds more modern. Reason: pdf.js's modern build calls
    `Map.prototype.getOrInsertComputed` (TC39 reached Stage 4 Oct 2025), which
    V8 hasn't shipped under the final name yet — even on Chromium 142. Legacy
    is transpiled around this. Not optional. Revisit when V8 release notes
    explicitly list `getOrInsertComputed`.
  - **We ship the `.min.mjs` variants** (`pdf.min.mjs` + `pdf.worker.min.mjs`),
    not the dev `.mjs`. Halves the bundle (~1.7 MB vs ~3.2 MB) for cold-start
    parse time. Source maps are excluded too. If you ever need to debug pdf.js
    internals, swap to the non-min files temporarily.

## .vscodeignore is aggressive on purpose

Default `vsce package` produced a 23.5 MB vsix because `pdfjs-dist` pulls in
`@napi-rs/canvas` (Node-side canvas, useless for our webview-only usage) and
ships cmaps, fonts, types, sourcemaps, web/, image_decoders/, and both
`build/` and `legacy/build/`. The current `.vscodeignore` keeps only
`legacy/build/pdf.min.mjs` + `legacy/build/pdf.worker.min.mjs` + LICENSE from
`pdfjs-dist`, and drops `@napi-rs/**` entirely. Result: ~535 KB.

If PDFs ever render with missing glyphs (uncommon scripts, non-Computer-Modern
fonts), re-include `cmaps/` and `standard_fonts/` and set `cMapUrl` /
`standardFontDataUrl` on the `getDocument()` call in `media/preview.js`.

## pdf.js worker must load via a `blob:` URL

VS Code webviews **refuse to spawn an ES-module Worker** from the
`vscode-webview://` URI scheme. When pdf.js tries
`new Worker(workerSrc, { type: "module" })` with our webview-served URI, the
spawn silently fails, pdf.js prints `Warning: Setting up fake worker`, and
falls back to running all parsing on the main thread. For a 13-page paper
that's a 30 s parse vs ~500 ms with a real worker.

Workaround in `media/preview.js`:
1. `fetch(workerUri)` to get the worker source as text via the webview URI.
2. Wrap in a `Blob`, get a `blob:` URL via `URL.createObjectURL()`.
3. Set `pdfjs.GlobalWorkerOptions.workerSrc = blobUrl`.

Browsers allow workers from `blob:` URLs even when other schemes are
restricted, so the spawn succeeds. The CSP needs two directives for this:
- `worker-src {{CSP_SOURCE}} blob:` — to allow the worker spawn.
- `connect-src {{CSP_SOURCE}}` — without this, `fetch()` falls back to
  `default-src 'none'` and is blocked. Easy to forget; symptom is a CSP
  violation on the fetch URL in the webview console.

Also: assign `pdfjs` to the global **only after** `workerSrc` is configured.
The message handler gates on `if (pdfjs)`; if `pdfjs` is set immediately
after `await import()` but before the fetch+blob completes, a "load" message
arriving in the gap calls `renderPdf` and pdf.js throws
`No "GlobalWorkerOptions.workerSrc" specified`. Hold the imported module in
a local until the worker is wired up.

## Compile gate

Auto-compile runs only when `preview` panel exists AND is visible. A hidden
preview tab pauses; switching back to it triggers a catch-up compile (via the
`pendingWhileHidden` flag). Manual `LaTeX Preview: Compile Now` bypasses both
gates. See `triggerCompile` in `src/extension.ts`.

## Figure regen is lazy, not eager

`figureWatch` globs only flag `figuresStale = true`. The next compile runs
`figureCommand` first if dirty, then the LaTeX driver. This avoids burning
CPU on figure regen during prose edits. A watched-file save will also
schedule a compile directly (gated on preview visibility, same as `.tex`
saves), so editing a figure source file → save → preview updates without
needing to touch a `.tex` too.

## Compile triggers on save, not on keystroke change

The trigger is `onDidSaveTextDocument`, not `onDidChangeTextDocument`. Reason:
the LaTeX driver reads from disk; `onDidChangeTextDocument` fires on the
in-memory buffer, so we'd recompile the stale on-disk version on every
keystroke — wasted work. Users with VS Code auto-save still get near-live
preview because auto-save fires save events after each idle pause.

## Stale-PDF prewarm hides MiKTeX cold start

`showPreview` reads any existing `<mainFile>.pdf` from disk and dispatches
it to the webview before kicking off `triggerCompile`. The fresh compile
runs in the background and replaces the stale render when it finishes.
Hides ~5–15 s of MiKTeX cold-start on the first compile after VS Code
launch. If no PDF exists yet (fresh clone), falls through silently.

## Bump `version` for every shippable change

`code --install-extension some.vsix` is a no-op if the manifest version
matches what's already installed — VS Code reports "already installed" and
keeps the old bits. So every change you want to ship to yourself needs a
`package.json` `version` bump, even a one-line fix. CI publishes the new
vsix to the rolling `latest` release at the same stable URL regardless of
version — the version only matters at the install-decision step.

Convention: patch-bump (0.0.X → 0.0.X+1) for everything during pre-1.0.
Don't try to be principled about semver while the API surface and behavior
are still moving.

## Preview panel modes: `compile` vs `static`

`previewMode` in `src/extension.ts` is `"compile"` by default and
`"static"` after **Open PDF**. The mode gates the `.tex` save listener and
the figure-watch markStale callback — both early-return when not in
compile mode. Reason: if you opened a plain PDF to look at it (e.g. a
build artifact, an unrelated document), editing your `.tex` shouldn't
silently overwrite the static viewer's contents with the latest paper
build.

Mode flips back to `compile` via three triggers:
- **Show** — explicit, also reveals + compiles.
- **Focusing a `.tex` editor** (via `onDidChangeActiveTextEditor`) — flips
  mode AND reloads the compiled `<mainFile>.pdf` from disk so the swap is
  immediately visible. Doesn't recompile; the next save does. (Without
  the reload, the flip is silent and feels like a no-op — the static PDF
  would linger until the user saved.)
- **Panel disposal** — closing the preview resets to compile for the next
  session.

Edge case the focus trigger doesn't catch: user has `.tex` active, opens
a PDF via the explorer right-click (active editor never changed), and
never loses focus from the `.tex` afterwards. Mode stays static. Workaround
is **Show** or clicking another text file then back. Cheap to fix later
by also listening to `onDidChangeTextEditorSelection` if it bites.

## Right-click → Compile Now uses `activeWebviewPanelId`

The `editor/title/context` menu entry for `latexPreview.compile` is gated
on `when: "activeWebviewPanelId == latexPreview"`. The string `latexPreview`
on the right must match the **first argument** of `createWebviewPanel`
(the `viewType`) in `src/preview.ts`. If you ever rename the viewType,
update this `when` clause too — otherwise the menu entry stops appearing
and there's no error message; it just silently doesn't show. Same
contract for any future tab-context entries you add.

## CI release: rolling `latest`, title shows version + timestamp

`.github/workflows/build.yml` updates a single GitHub Release tagged
`latest` on every push to `main` (PRs skip the release step). The release
title is set to `v<version> — <YYYY-MM-DD HH:MM UTC>` so the date+version
is visible at a glance in the Releases list — that was the explicit fix
for the "commit-hash-as-release-name made history hard to read" problem
seen in the 2piece paper.yml. The vsix asset is uploaded with
`--clobber` so the asset filename stays `latex-preview.vsix` and the
stable download URL `releases/latest/download/latex-preview.vsix` always
points at the current build.

If you ever want versioned releases instead of rolling, switch the
trigger to `on.push.tags: 'v*'` and drop the `--clobber` / fixed-tag
machinery. The current rolling design is deliberate for a personal
extension where every push *is* the new release.

## Lazy rendering via IntersectionObserver

`media/preview.js` does the render in two passes:
1. Synchronously create blank canvases sized to each page from
   `page.getViewport()`, swap into the container in one shot. Layout and
   scroll position settle immediately.
2. An `IntersectionObserver` (rootMargin 400 px) renders each page's actual
   content when (or just before) it enters the viewport.

For a 13-page paper the user sees the first ~3 pages within ~500 ms instead
of waiting ~3–4 s for all pages to render serially. Scrolling rapidly may
show blank canvases for a frame before they're rendered — acceptable
tradeoff. The observer is disconnected on each new render to avoid
callbacks firing against detached canvases.
