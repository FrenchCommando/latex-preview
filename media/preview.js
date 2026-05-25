const vscode = acquireVsCodeApi();

const statusEl = document.getElementById("status");
const errorEl = document.getElementById("error");
const warningEl = document.getElementById("warning");
const containerEl = document.getElementById("container");

// Signal readiness immediately so the extension can flush any queued
// messages (status / error / pending PDF) — even if pdf.js fails to load,
// we still want compile errors to reach the panel.
vscode.postMessage({ type: "ready" });

const SCALE = 1.5;
let renderToken = 0;
let pdfjs = null;
let pdfjsLoadError = null;

function setStatus(text) {
  if (text) {
    statusEl.textContent = text;
    statusEl.classList.remove("hidden");
  } else {
    statusEl.classList.add("hidden");
  }
}

function setError(text) {
  if (text) {
    errorEl.textContent = text;
    errorEl.classList.remove("hidden");
  } else {
    errorEl.classList.add("hidden");
  }
}

function setWarning(text) {
  if (text) {
    warningEl.textContent = text;
    warningEl.classList.remove("hidden");
  } else {
    warningEl.classList.add("hidden");
  }
}

async function renderPdf(data) {
  if (!pdfjs) {
    setError(
      pdfjsLoadError
        ? `pdf.js failed to load: ${pdfjsLoadError}`
        : "pdf.js still loading, please retry the compile.",
    );
    return;
  }
  const token = ++renderToken;
  setStatus("Rendering…");
  setError("");
  const previousScroll = window.scrollY;
  const loadingTask = pdfjs.getDocument({ data });
  const pdf = await loadingTask.promise;
  if (token !== renderToken) return;

  // Render pages into a fragment, then swap into the container in one shot
  // so the user doesn't see a flicker of an empty container mid-recompile.
  const fragment = document.createDocumentFragment();
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    if (token !== renderToken) return;
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: SCALE });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const context = canvas.getContext("2d");
    fragment.appendChild(canvas);
    await page.render({ canvasContext: context, viewport }).promise;
  }

  if (token !== renderToken) return;
  containerEl.replaceChildren(fragment);
  setStatus("");
  window.scrollTo(0, previousScroll);
  vscode.setState({ scroll: previousScroll });
}

const restoredState = vscode.getState();
if (restoredState && typeof restoredState.scroll === "number") {
  window.scrollTo(0, restoredState.scroll);
}

window.addEventListener("scroll", () => {
  vscode.setState({ scroll: window.scrollY });
});

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg || typeof msg.type !== "string") return;
  if (msg.type === "load") {
    renderPdf(msg.data).catch((err) => {
      setStatus("");
      setError(`Render error: ${err.message ?? err}`);
    });
  } else if (msg.type === "error") {
    setStatus("");
    setWarning("");
    setError(msg.log);
  } else if (msg.type === "warning") {
    setError("");
    setWarning(msg.log);
  } else if (msg.type === "status") {
    setStatus(msg.text);
  }
});

// Load pdf.js asynchronously. If it fails (CSP, missing file, etc.) the
// rest of the panel still works for showing the compile log.
try {
  pdfjs = await import(window.__PDFJS_URI__);
  pdfjs.GlobalWorkerOptions.workerSrc = window.__WORKER_URI__;
} catch (err) {
  pdfjsLoadError = err && err.message ? err.message : String(err);
  // Only surface this if nothing more important is already shown.
  if (errorEl.classList.contains("hidden")) {
    setError(`pdf.js failed to load: ${pdfjsLoadError}`);
  }
}
