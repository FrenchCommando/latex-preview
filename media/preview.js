const vscode = acquireVsCodeApi();
const T0 = performance.now();
const trace = (label) => {
  // eslint-disable-next-line no-console
  console.log(`[+${(performance.now() - T0).toFixed(0).padStart(5)} ms] ${label}`);
};
trace("preview.js start");

const statusEl = document.getElementById("status");
const errorEl = document.getElementById("error");
const warningEl = document.getElementById("warning");
const containerEl = document.getElementById("container");

// Signal readiness immediately so the extension can flush any queued
// messages (status / error / pending PDF) — even if pdf.js fails to load,
// we still want compile errors to reach the panel.
vscode.postMessage({ type: "ready" });
trace("ready posted");

const SCALE = 1.5;
let renderToken = 0;
let pdfjs = null;
let pdfjsLoadError = null;
let pageObserver = null;
// Buffer the most recent "load" message that arrived before pdf.js was ready.
// Without this, the stale-PDF prewarm on cold open is silently dropped.
let pendingPdfData = null;

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
    // Should not happen — caller is expected to gate on pdfjs being ready.
    // If we get here anyway, surface it so we don't fail silently.
    setError(
      pdfjsLoadError
        ? `pdf.js failed to load: ${pdfjsLoadError}`
        : "pdf.js still loading.",
    );
    return;
  }
  const token = ++renderToken;
  trace(`renderPdf start (${data.byteLength ?? data.length} bytes)`);
  setStatus("Loading…");
  setError("");
  const previousScroll = window.scrollY;
  const pdf = await pdfjs.getDocument({ data }).promise;
  trace(`pdf parsed (${pdf.numPages} pages)`);
  if (token !== renderToken) return;

  // Tear down any previous observer so its callbacks don't fire against
  // detached canvases from the old PDF.
  if (pageObserver) {
    pageObserver.disconnect();
    pageObserver = null;
  }

  // Pass 1: build sized-but-blank canvases for every page and swap into the
  // container in one shot. Layout is settled immediately, so scroll position
  // is preserved exactly without waiting for any rendering.
  const fragment = document.createDocumentFragment();
  const pageData = [];
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    if (token !== renderToken) return;
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: SCALE });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    fragment.appendChild(canvas);
    pageData.push({ page, viewport, canvas, rendered: false });
  }
  if (token !== renderToken) return;
  containerEl.replaceChildren(fragment);
  window.scrollTo(0, previousScroll);
  vscode.setState({ scroll: previousScroll });
  setStatus("");
  trace("placeholders swapped in; pages render lazily as scrolled into view");

  // Pass 2: render each page when (or just before) it enters the viewport.
  // rootMargin pre-renders a window's worth above and below current view so
  // scrolling stays smooth.
  pageObserver = new IntersectionObserver(
    (entries) => {
      if (token !== renderToken) return;
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const p = pageData.find((x) => x.canvas === entry.target);
        if (!p || p.rendered) continue;
        p.rendered = true;
        pageObserver.unobserve(entry.target);
        p.page
          .render({ canvasContext: entry.target.getContext("2d"), viewport: p.viewport })
          .promise.catch((err) => {
            p.rendered = false;
            // eslint-disable-next-line no-console
            console.error(`page render failed: ${err.message ?? err}`);
          });
      }
    },
    { rootMargin: "400px 0px" },
  );
  for (const p of pageData) pageObserver.observe(p.canvas);
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
    if (pdfjs) {
      renderPdf(msg.data).catch((err) => {
        setStatus("");
        setError(`Render error: ${err.message ?? err}`);
      });
    } else if (pdfjsLoadError) {
      setError(`Can't render — pdf.js failed to load: ${pdfjsLoadError}`);
    } else {
      // pdf.js still booting; render this PDF as soon as it's ready.
      pendingPdfData = msg.data;
    }
  } else if (msg.type === "error") {
    setStatus("");
    setWarning("");
    setError(msg.log);
  } else if (msg.type === "warning") {
    setError("");
    setWarning(msg.log);
  } else if (msg.type === "status") {
    // A non-empty status means a new run is starting (compiling, loading,
    // regenerating figures). Any error/warning on screen is from the previous
    // run and would otherwise stay visible alongside "Compiling…", making a
    // successful retry look like a repeat failure until renderPdf clears it.
    if (msg.text) {
      setError("");
      setWarning("");
    }
    setStatus(msg.text);
  }
});

// Load pdf.js asynchronously. If it fails (CSP, missing file, etc.) the
// rest of the panel still works for showing the compile log.
try {
  trace("import pdf.js start");
  const pdfjsModule = await import(window.__PDFJS_URI__);
  trace("import pdf.js done");
  // VS Code webviews refuse to spawn an ES-module Worker from their own
  // vscode-webview:// URI scheme, so pdf.js falls back to a "fake worker"
  // that runs parse + render on the main thread (30 s+ for a 13-page paper
  // vs ~1 s with a real worker). Fetch the worker source ourselves and feed
  // pdf.js a blob URL — CSP allows worker-src blob:, and the worker spawns
  // for real.
  trace("fetch worker source");
  const workerSrc = await (await fetch(window.__WORKER_URI__)).text();
  const workerBlob = new Blob([workerSrc], { type: "text/javascript" });
  pdfjsModule.GlobalWorkerOptions.workerSrc = URL.createObjectURL(workerBlob);
  trace("worker blob URL set");
  // Expose pdfjs only after workerSrc is configured. Otherwise a "load"
  // message arriving in the gap between import resolution and worker setup
  // would slip past the `if (pdfjs)` gate and renderPdf would throw with
  // "No GlobalWorkerOptions.workerSrc specified".
  pdfjs = pdfjsModule;
  // Flush any PDF that arrived while pdf.js was still loading (stale-PDF
  // prewarm on cold open).
  if (pendingPdfData) {
    trace("flushing pending PDF");
    const data = pendingPdfData;
    pendingPdfData = null;
    renderPdf(data).catch((err) => {
      setStatus("");
      setError(`Render error: ${err.message ?? err}`);
    });
  }
} catch (err) {
  pdfjsLoadError = err && err.message ? err.message : String(err);
  // Only surface this if nothing more important is already shown.
  if (errorEl.classList.contains("hidden")) {
    setError(`pdf.js failed to load: ${pdfjsLoadError}`);
  }
}
