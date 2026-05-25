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
- `engines.vscode ^1.120.0` matches the `@types/vscode` we installed. Bump them
  together.
- `pdfjs-dist ^5.7.0` — uses ESM (`pdf.mjs` + `pdf.worker.mjs`). The webview
  dynamic-imports them at runtime.

## .vscodeignore is aggressive on purpose

Default `vsce package` produced a 23.5 MB vsix because `pdfjs-dist` pulls in
`@napi-rs/canvas` (Node-side canvas, useless for our webview-only usage) and
ships cmaps, fonts, types, sourcemaps, and a `legacy/` build. The current
`.vscodeignore` keeps only `build/pdf.mjs` + `build/pdf.worker.mjs` + LICENSE
from `pdfjs-dist`, and drops `@napi-rs/**` entirely. Result: ~630 KB.

If PDFs ever render with missing glyphs (uncommon scripts, non-Computer-Modern
fonts), re-include `cmaps/` and `standard_fonts/` and set `cMapUrl` /
`standardFontDataUrl` on the `getDocument()` call in `media/preview.js`.

## Compile gate

Auto-compile runs only when `preview` panel exists AND is visible. A hidden
preview tab pauses; switching back to it triggers a catch-up compile (via the
`pendingWhileHidden` flag). Manual `LaTeX Preview: Compile Now` bypasses both
gates. See `triggerCompile` in `src/extension.ts`.

## Figure regen is lazy, not eager

`figureWatch` globs only flag `figuresStale = true`. The next latex compile
runs `figureCommand` first if dirty, then latexmk. This avoids burning CPU on
figure regen during prose edits.
