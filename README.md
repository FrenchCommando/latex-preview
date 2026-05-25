# LaTeX Preview

Minimal VS Code extension: edit a `.tex` file, get a live PDF preview in a side
panel. Compiles via `latexmk`, renders via `pdf.js` in a webview.

## Requirements

- `latexmk` on `PATH` (any TeX distribution: MiKTeX, TeX Live, etc.).
- VS Code `^1.115.0`.

## Install

### Pre-built vsix (recommended)

Every push to `main` updates a rolling **`latest`** GitHub Release with the
freshly-built `.vsix`. Stable download URL:

```
https://github.com/FrenchCommando/latex-preview/releases/latest/download/latex-preview.vsix
```

Install:

```cmd
curl -L -o latex-preview.vsix https://github.com/FrenchCommando/latex-preview/releases/latest/download/latex-preview.vsix
code --install-extension latex-preview.vsix
```

Or in VS Code: **Extensions** panel → `...` menu → **Install from VSIX...**.

### From source

```cmd
npm install
npm run compile
npm run package
code --install-extension latex-preview-0.0.1.vsix
```

## Use

1. Open a workspace containing a `.tex` file.
2. Run **LaTeX Preview: Show** from the command palette.
3. Edit the `.tex` — the preview recompiles after typing stops (default 800 ms).

Commands:

- **LaTeX Preview: Show** — open or focus the preview panel.
- **LaTeX Preview: Compile Now** — force a compile (bypasses visibility gate).

Auto-compile only runs when the preview panel is visible. Hidden tabs pause and
catch up on re-focus.

## Configuration

Per-project settings live in `latex-preview.json` at the workspace root. The
extension watches this file for live reload. A JSON schema gives IntelliSense
when editing it.

```json
{
  "mainFile": "paper/main.tex",
  "debounceMs": 800,
  "latexmkArgs": ["-pdf", "-interaction=nonstopmode", "-halt-on-error", "-file-line-error"],
  "figureWatch": ["scripts/figures/**", "data/**"],
  "figureCommand": "npm run figures"
}
```

| Key | Default | Purpose |
|---|---|---|
| `mainFile` | `""` (active editor) | Path to the root `.tex`. Empty = use whichever `.tex` is active. |
| `debounceMs` | `800` | Idle ms after typing stops before recompile. |
| `latexmkArgs` | see schema | Args passed to `latexmk` before the filename. |
| `figureWatch` | `[]` | Globs (workspace-relative) whose changes mark figures stale. |
| `figureCommand` | `""` | Shell command run from workspace root before `latexmk` when figures are stale. Empty = disabled. |

### Figure regen is lazy

Changes to files matching `figureWatch` set a "stale" flag. The flag is
consumed at the *next* `latexmk` run (which `figureCommand` runs first). So
prose edits don't burn CPU on figure rebuilds — only the compile that actually
needs fresh figures does.

## Development

Scripts:

- `npm run compile` — `tsc -p .` → `out/`
- `npm run watch` — incremental TS rebuild
- `npm run package` — produce `latex-preview-<version>.vsix` (does **not**
  compile first; run `npm run compile` if `out/` is stale)

CI lives at `.github/workflows/build.yml`: checkout → `npm ci` → compile →
package → upload artifact. Runs on push/PR to `main` and on manual dispatch.

`NOTES.md` (in this repo, not shipped in the vsix) captures build pins,
packaging trade-offs, and other non-obvious decisions.

## License

MIT
