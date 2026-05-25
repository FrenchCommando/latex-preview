const vscode = acquireVsCodeApi();

const statusEl = document.getElementById("status");
const errorEl = document.getElementById("error");
const containerEl = document.getElementById("container");

const pdfjs = await import(window.__PDFJS_URI__);
pdfjs.GlobalWorkerOptions.workerSrc = window.__WORKER_URI__;

const SCALE = 1.5;
let renderToken = 0;

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

async function renderPdf(data) {
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
    setError(msg.log);
  } else if (msg.type === "status") {
    setStatus(msg.text);
  }
});

vscode.postMessage({ type: "ready" });
