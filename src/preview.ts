import * as vscode from "vscode";
import * as fs from "node:fs/promises";

export class PreviewPanel {
  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private ready = false;
  private pendingPdf: Uint8Array | null = null;
  private pendingError: string | null = null;

  constructor(extensionUri: vscode.Uri, onDispose: () => void) {
    this.extensionUri = extensionUri;
    this.panel = vscode.window.createWebviewPanel(
      "latexPreview",
      "LaTeX Preview",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, "media"),
          vscode.Uri.joinPath(extensionUri, "node_modules", "pdfjs-dist", "build"),
        ],
      },
    );

    this.panel.onDidDispose(onDispose);
    this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg));

    this.loadHtml().then((html) => {
      this.panel.webview.html = html;
    });
  }

  reveal() {
    this.panel.reveal(vscode.ViewColumn.Beside, true);
  }

  isVisible(): boolean {
    return this.panel.visible;
  }

  onDidChangeVisibility(callback: (visible: boolean) => void): vscode.Disposable {
    return this.panel.onDidChangeViewState((event) => callback(event.webviewPanel.visible));
  }

  setStatus(text: string) {
    this.post({ type: "status", text });
  }

  load(data: Uint8Array) {
    if (this.ready) {
      this.panel.webview.postMessage({ type: "load", data });
    } else {
      this.pendingPdf = data;
    }
  }

  showError(log: string) {
    if (this.ready) {
      this.panel.webview.postMessage({ type: "error", log });
    } else {
      this.pendingError = log;
    }
  }

  private post(msg: unknown) {
    if (this.ready) {
      this.panel.webview.postMessage(msg);
    }
  }

  private onMessage(msg: { type?: string }) {
    if (msg.type === "ready") {
      this.ready = true;
      if (this.pendingPdf) {
        this.panel.webview.postMessage({ type: "load", data: this.pendingPdf });
        this.pendingPdf = null;
      }
      if (this.pendingError) {
        this.panel.webview.postMessage({ type: "error", log: this.pendingError });
        this.pendingError = null;
      }
    }
  }

  private async loadHtml(): Promise<string> {
    const webview = this.panel.webview;
    const mediaDir = vscode.Uri.joinPath(this.extensionUri, "media");
    const pdfjsDir = vscode.Uri.joinPath(
      this.extensionUri,
      "node_modules",
      "pdfjs-dist",
      "build",
    );

    const pdfjsUri = webview.asWebviewUri(vscode.Uri.joinPath(pdfjsDir, "pdf.mjs"));
    const workerUri = webview.asWebviewUri(vscode.Uri.joinPath(pdfjsDir, "pdf.worker.mjs"));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaDir, "preview.js"));
    const htmlPath = vscode.Uri.joinPath(mediaDir, "preview.html").fsPath;

    const template = await fs.readFile(htmlPath, "utf8");
    return template
      .replace(/__PDFJS_URI__/g, pdfjsUri.toString())
      .replace(/__WORKER_URI__/g, workerUri.toString())
      .replace(/__SCRIPT_URI__/g, scriptUri.toString())
      .replace(/__CSP_SOURCE__/g, webview.cspSource);
  }
}
