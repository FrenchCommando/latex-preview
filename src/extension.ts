import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { compile, runShell } from "./compiler";
import { PreviewPanel } from "./preview";
import { ProjectConfig, DEFAULT_CONFIG, CONFIG_FILENAME, loadConfig } from "./config";

let preview: PreviewPanel | null = null;
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
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (!event.document.uri.fsPath.endsWith(".tex")) return;
      if (!preview) return;
      if (!preview.isVisible()) {
        pendingWhileHidden = true;
        return;
      }
      scheduleCompile(context);
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
  if (!preview) {
    const created = new PreviewPanel(context.extensionUri, () => {
      preview = null;
      pendingWhileHidden = false;
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
  preview.reveal();
  await triggerCompile(context, /*force*/ true);
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
    if (result.success && result.pdfPath) {
      output.appendLine("Compile OK");
      const data = await fs.readFile(result.pdfPath);
      preview?.load(new Uint8Array(data));
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
