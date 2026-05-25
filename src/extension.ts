import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { compile, runShell } from "./compiler";
import { PreviewPanel } from "./preview";
import { ProjectConfig, DEFAULT_CONFIG, CONFIG_FILENAME, loadConfig } from "./config";

let preview: PreviewPanel | null = null;
let previewMode: "compile" | "static" = "compile";
let debounceTimer: NodeJS.Timeout | null = null;
let compiling = false;
let pendingPath: string | null = null;
let pendingWhileHidden = false;
let figuresStale = false;
let figureWatchers: vscode.FileSystemWatcher[] = [];
let projectConfig: ProjectConfig = { ...DEFAULT_CONFIG };
let output: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel("LaTeX Preview");
  context.subscriptions.push(output);

  context.subscriptions.push(
    vscode.commands.registerCommand("latexPreview.show", () => showPreview(context)),
    vscode.commands.registerCommand("latexPreview.compile", () =>
      triggerCompile(context, /*force*/ true),
    ),
    vscode.commands.registerCommand("latexPreview.openPdf", (uri?: vscode.Uri) =>
      openPdfFile(context, uri),
    ),
  );

  context.subscriptions.push(
    // Compile on save, not on change: latexmk/texify reads from disk, so
    // recompiling on every keystroke is wasted work against stale bytes.
    // Users with VS Code auto-save still get near-live preview because
    // auto-save fires a save event after each idle pause.
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (previewMode !== "compile") return;
      if (!document.uri.fsPath.endsWith(".tex")) return;
      if (!preview) return;
      if (!preview.isVisible()) {
        pendingWhileHidden = true;
        return;
      }
      scheduleCompile(context);
    }),
    // Auto-flip out of static mode when the user focuses a .tex editor.
    // Their attention is back on the LaTeX source, so the next save should
    // recompile. Also swap the displayed PDF back to the compiled paper
    // (if one exists on disk) so the mode flip is actually visible —
    // otherwise the static figure PDF lingers until the next save and the
    // flip feels like a no-op.
    vscode.window.onDidChangeActiveTextEditor(async (editor) => {
      if (previewMode !== "static") return;
      if (!preview) return;
      if (!editor) return;
      if (!editor.document.uri.fsPath.endsWith(".tex")) return;
      previewMode = "compile";
      output.appendLine("Focused .tex editor — preview mode → compile");
      await loadExistingPdfIfAny(Date.now());
    }),
  );

  watchProjectConfig(context);
  void reloadProjectConfig(context);
}

export function deactivate() {
  disposeFigureWatchers();
}

async function reloadProjectConfig(context: vscode.ExtensionContext) {
  projectConfig = await loadConfig(workspaceRoot(), output);
  registerFigureWatchers(context);
}

function watchProjectConfig(context: vscode.ExtensionContext) {
  const root = workspaceRoot();
  if (!root) return;
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(root, CONFIG_FILENAME),
  );
  const reload = () => {
    output.appendLine(`${CONFIG_FILENAME} changed — reloading config`);
    void reloadProjectConfig(context);
  };
  watcher.onDidChange(reload);
  watcher.onDidCreate(reload);
  watcher.onDidDelete(reload);
  context.subscriptions.push(watcher);
}

async function showPreview(context: vscode.ExtensionContext) {
  const t0 = Date.now();
  logTime("Show invoked", t0, t0);
  ensurePanel(context);
  logTime("panel ensured", t0, Date.now());
  previewMode = "compile";
  preview!.reveal();
  logTime("panel revealed", t0, Date.now());
  await loadExistingPdfIfAny(t0);
  logTime("stale PDF dispatched", t0, Date.now());
  await triggerCompile(context, /*force*/ true);
  logTime("fresh compile finished", t0, Date.now());
}

function logTime(label: string, t0: number, now: number) {
  output.appendLine(`[+${(now - t0).toString().padStart(5)} ms] ${label}`);
}

async function loadExistingPdfIfAny(t0: number) {
  const texPath = resolveTexPath();
  if (!texPath || !preview) {
    output.appendLine(
      `[+${(Date.now() - t0).toString().padStart(5)} ms] no tex/preview, skip stale prewarm`,
    );
    return;
  }
  const pdfPath = path.join(
    path.dirname(texPath),
    `${path.basename(texPath, path.extname(texPath))}.pdf`,
  );
  try {
    const buf = await fs.readFile(pdfPath);
    logTime(`read stale PDF (${buf.length} bytes) from ${pdfPath}`, t0, Date.now());
    preview.load(new Uint8Array(buf));
    preview.setStatus("Showing previous PDF — compiling fresh…");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    output.appendLine(
      `[+${(Date.now() - t0).toString().padStart(5)} ms] no stale PDF at ${pdfPath}: ${message}`,
    );
  }
}

async function openPdfFile(context: vscode.ExtensionContext, uri?: vscode.Uri) {
  let pdfPath: string | null = uri?.fsPath ?? null;
  if (!pdfPath) {
    const editor = vscode.window.activeTextEditor;
    const activePath = editor?.document.uri.fsPath;
    if (activePath?.toLowerCase().endsWith(".pdf")) {
      pdfPath = activePath;
    }
  }
  if (!pdfPath) {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { PDF: ["pdf"] },
      openLabel: "Open in LaTeX Preview",
    });
    pdfPath = picked?.[0]?.fsPath ?? null;
  }
  if (!pdfPath) {
    vscode.window.showWarningMessage("LaTeX Preview: no PDF selected.");
    return;
  }

  ensurePanel(context);
  previewMode = "static";
  preview!.reveal();
  preview!.setStatus(`Loading ${path.basename(pdfPath)}…`);
  try {
    const buf = await fs.readFile(pdfPath);
    preview!.load(new Uint8Array(buf));
    output.appendLine(`Loaded PDF: ${pdfPath}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    output.appendLine(`Failed to load PDF ${pdfPath}: ${message}`);
    preview!.showError(`Failed to load PDF:\n${message}`);
  }
}

function ensurePanel(context: vscode.ExtensionContext) {
  if (preview) return;
  const created = new PreviewPanel(context.extensionUri, () => {
    preview = null;
    pendingWhileHidden = false;
    previewMode = "compile";
  });
  preview = created;
  context.subscriptions.push(
    created.onDidChangeVisibility((visible) => {
      if (visible && pendingWhileHidden) {
        pendingWhileHidden = false;
        scheduleCompile(context);
      }
    }),
  );
}

function scheduleCompile(context: vscode.ExtensionContext) {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    triggerCompile(context, /*force*/ false).catch((err) => {
      output.appendLine(`Compile error: ${err}`);
    });
  }, projectConfig.debounceMs);
}

async function triggerCompile(context: vscode.ExtensionContext, force: boolean) {
  const texPath = resolveTexPath();
  if (!texPath) {
    if (force) vscode.window.showWarningMessage("LaTeX Preview: no .tex file to compile.");
    return;
  }

  if (!force) {
    if (!preview) return;
    if (!preview.isVisible()) {
      pendingWhileHidden = true;
      return;
    }
  }

  if (compiling) {
    pendingPath = texPath;
    return;
  }

  compiling = true;
  preview?.setStatus("Compiling…");
  try {
    if (figuresStale && projectConfig.figureCommand) {
      const cwd = workspaceRoot() ?? path.dirname(texPath);
      preview?.setStatus("Regenerating figures…");
      output.appendLine(`Running figureCommand: ${projectConfig.figureCommand}`);
      const figureResult = await runShell(projectConfig.figureCommand, cwd);
      if (figureResult.log) output.appendLine(figureResult.log);
      if (!figureResult.success) {
        preview?.showError(`figureCommand failed:\n${figureResult.log}`);
        return;
      }
      figuresStale = false;
    }

    output.appendLine(`Compiling ${texPath} with ${projectConfig.latexCommand}`);
    preview?.setStatus("Compiling…");
    const result = await compile(texPath, projectConfig.latexCommand, projectConfig.latexArgs);

    let pdfData: Uint8Array | null = null;
    if (result.pdfPath) {
      try {
        const buf = await fs.readFile(result.pdfPath);
        pdfData = new Uint8Array(buf);
      } catch {
        // PDF wasn't produced; fall through to error path.
      }
    }

    if (result.success && pdfData) {
      output.appendLine("Compile OK");
      preview?.load(pdfData);
    } else if (pdfData) {
      output.appendLine("Compile finished with errors; rendering partial PDF");
      output.appendLine(result.log);
      preview?.load(pdfData);
      preview?.showWarning(result.log || "Compile finished with errors.");
    } else {
      output.appendLine(result.log);
      preview?.showError(result.log || "Compile failed.");
    }
  } finally {
    compiling = false;
    if (pendingPath) {
      const next = pendingPath;
      pendingPath = null;
      void Promise.resolve().then(() => {
        if (next === resolveTexPath()) triggerCompile(context, /*force*/ false);
      });
    }
  }
}

function resolveTexPath(): string | null {
  const root = workspaceRoot();
  const mainFile = projectConfig.mainFile.trim();
  if (mainFile) {
    return root ? path.resolve(root, mainFile) : mainFile;
  }
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.uri.fsPath.endsWith(".tex")) {
    return editor.document.uri.fsPath;
  }
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.uri.fsPath.endsWith(".tex")) return doc.uri.fsPath;
  }
  return null;
}

function workspaceRoot(): string | null {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length > 0 ? folders[0].uri.fsPath : null;
}

function registerFigureWatchers(context: vscode.ExtensionContext) {
  disposeFigureWatchers();
  const root = workspaceRoot();
  if (!root) return;
  for (const pattern of projectConfig.figureWatch) {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(root, pattern),
    );
    const markStale = (uri: vscode.Uri) => {
      figuresStale = true;
      output.appendLine(`Figure source changed: ${uri.fsPath} → figures marked stale`);
      // Trigger compile now if the preview is open and in compile mode.
      // Visibility gate inside triggerCompile handles the hidden case via
      // pendingWhileHidden, so switching back to the preview catches up.
      if (!preview || previewMode !== "compile") return;
      if (preview.isVisible()) {
        scheduleCompile(context);
      } else {
        pendingWhileHidden = true;
      }
    };
    watcher.onDidChange(markStale);
    watcher.onDidCreate(markStale);
    watcher.onDidDelete(markStale);
    figureWatchers.push(watcher);
    context.subscriptions.push(watcher);
  }
}

function disposeFigureWatchers() {
  for (const watcher of figureWatchers) watcher.dispose();
  figureWatchers = [];
}
