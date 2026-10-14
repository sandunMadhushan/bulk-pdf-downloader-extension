importScripts("zip.js");

const SUBFOLDER = "BulkPDFDownloader";
const DELAY_MS = 350; // stagger between downloads so Chrome doesn't throttle/flag them
const DOWNLOAD_TIMEOUT_MS = 25000; // safety net if onChanged never fires

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Sub-path a file goes under, inside BulkPDFDownloader/ or inside the zip:
// the Moodle section folders ("Year 1/Semester 2/2025 Oct-Nov") worked out
// by popup.js, or the class name for Classroom items.
function folderPrefix(file) {
  const folder = file.folder || file.classFolder || "";
  return folder ? `${folder}/` : "";
}

// Build the candidate download URL(s) for a file. Generic v1 items already
// carry a direct `url` and get returned as-is. Classroom/Drive items carry
// `id` + `type` and get resolved here.
function candidateUrls(file) {
  if (file.urls && file.urls.length) return file.urls; // pre-resolved by caller
  if (file.url) return [file.url]; // v1-style generic item

  const { id, type } = file;
  switch (type) {
    case "doc":
      return [`https://docs.google.com/document/d/${id}/export?format=pdf`];
    case "slides":
      return [`https://docs.google.com/presentation/d/${id}/export/pdf`];
    case "sheet":
      return [`https://docs.google.com/spreadsheets/d/${id}/export?format=pdf`];
    case "pdf":
    case "unknown":
    default:
      // Native Drive file. Try the classic endpoint first, then the
      // large-file "skip virus scan warning" endpoint if that one turns
      // out to have served an HTML interstitial instead of real bytes.
      // NOTE: the drive.usercontent.google.com fallback is the current
      // (2024+) replacement for the old confirm=<token> flow, but Google
      // has changed this endpoint more than once historically -- if this
      // fallback stops working, that's the first thing to re-check.
      return [
        `https://drive.google.com/uc?export=download&id=${id}`,
        `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`,
      ];
  }
}

function attemptDownload(url, filename) {
  return new Promise((resolve) => {
    chrome.downloads.download(
      { url, filename, saveAs: false, conflictAction: "uniquify" },
      (downloadId) => {
        if (chrome.runtime.lastError || downloadId === undefined) {
          resolve({ ok: false, reason: chrome.runtime.lastError?.message || "download-failed" });
          return;
        }

        let settled = false;
        const finish = (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          chrome.downloads.onChanged.removeListener(listener);
          resolve(result);
        };

        const timer = setTimeout(() => finish({ ok: true, downloadId, reason: "timeout-assumed-ok" }), DOWNLOAD_TIMEOUT_MS);

        const listener = (delta) => {
          if (delta.id !== downloadId) return;
          if (delta.state && delta.state.current === "interrupted") {
            finish({ ok: false, reason: "interrupted" });
          } else if (delta.state && delta.state.current === "complete") {
            chrome.downloads.search({ id: downloadId }, (results) => {
              const info = results[0];
              const isHtmlInterstitial = info && info.mime && info.mime.startsWith("text/html");
              if (isHtmlInterstitial) {
                // This is almost certainly Drive's "can't scan this file for
                // viruses" warning page, not the actual PDF -- remove it and
                // report failure so the caller can try the next candidate.
                chrome.downloads.removeFile(downloadId, () => {
                  finish({ ok: false, reason: "interstitial" });
                });
              } else {
                finish({ ok: true, downloadId });
              }
            });
          }
        };
        chrome.downloads.onChanged.addListener(listener);
      }
    );
  });
}

async function downloadFile(file) {
  const urls = candidateUrls(file);
  const filename = `${SUBFOLDER}/${folderPrefix(file)}${file.filename}`;

  let lastReason = "no-candidates";
  for (const url of urls) {
    const result = await attemptDownload(url, filename);
    if (result.ok) return result;
    lastReason = result.reason;
  }
  return { ok: false, reason: lastReason, file };
}

async function downloadIndividually(files) {
  let done = 0;
  let failed = 0;
  const failures = [];

  for (const file of files) {
    const result = await downloadFile(file);
    if (!result.ok) {
      failed += 1;
      failures.push({ filename: file.filename, reason: result.reason, viewUrl: file.viewUrl });
    }
    done += 1;
    chrome.runtime.sendMessage({ type: "DOWNLOAD_PROGRESS", done, total: files.length, asZip: false }).catch(() => {});
    await sleep(DELAY_MS);
  }

  chrome.runtime.sendMessage({ type: "DOWNLOAD_COMPLETE", done, failed, failures, asZip: false }).catch(() => {});
}


// Bundling requires the actual bytes (not just triggering a save-to-disk).
// A background-page fetch() to a cross-origin URL turned out to be
// unreliable -- confirmed on a live test (every single fetch failed with a
// generic "TypeError: Failed to fetch", even after the caller had been
// granted the "<all_urls>" optional host permission via chrome.permissions.
// request). Rather than chase that further, this runs the fetch *inside the
// target tab itself* via chrome.scripting.executeScript -- since zip mode
// only ever bundles items that came from scanning that same tab (see the
// mode === "generic" check in popup.js), the file is always same-origin to
// the page, so this is exactly like the page fetching its own file: no
// CORS issue, no extra permission prompt, just the activeTab/scripting
// access the extension already has.
async function fetchBase64InPage(url) {
  try {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) return { ok: false, reason: `http-${res.status}` };
    const contentType = res.headers.get("content-type") || "";
    if (contentType.startsWith("text/html")) return { ok: false, reason: "interstitial" };
    const bytes = new Uint8Array(await res.arrayBuffer());
    // Returned through chrome.scripting's structured-clone boundary as a
    // base64 string rather than the raw bytes -- simplest thing that's
    // guaranteed to survive that boundary intact for large files.
    let binary = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return { ok: true, base64: btoa(binary) };
  } catch (e) {
    return { ok: false, reason: "fetch-failed" };
  }
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes) {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function fetchFileBase64InTab(tabId, file) {
  const urls = candidateUrls(file);
  let lastReason = "no-candidates";
  for (const url of urls) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: fetchBase64InPage,
        args: [url],
      });
      if (result && result.ok) return { ok: true, base64: result.base64 };
      lastReason = (result && result.reason) || "inject-failed";
    } catch (e) {
      console.warn("Bulk PDF Downloader: in-page fetch failed for", url, e);
      lastReason = "inject-failed";
    }
  }
  return { ok: false, reason: lastReason };
}

function startDownload(url, filename) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download({ url, filename, saveAs: false, conflictAction: "uniquify" }, (downloadId) => {
      if (chrome.runtime.lastError || downloadId === undefined) {
        reject(new Error(chrome.runtime.lastError?.message || "download-failed"));
      } else {
        resolve(downloadId);
      }
    });
  });
}

function makeZipReporter(total) {
  const report = { done: 0, failed: 0, failures: [] };
  report.fileDone = (file, result) => {
    if (!result.ok) {
      report.failed += 1;
      report.failures.push({ filename: file.filename, reason: result.reason, viewUrl: file.viewUrl });
    }
    report.done += 1;
    chrome.runtime
      .sendMessage({ type: "DOWNLOAD_PROGRESS", done: report.done, total, asZip: true })
      .catch(() => {});
  };
  report.saving = () => {
    chrome.runtime
      .sendMessage({ type: "DOWNLOAD_PROGRESS", stage: "saving", done: report.done, total, asZip: true })
      .catch(() => {});
  };
  report.complete = () => {
    const { done, failed, failures } = report;
    chrome.runtime.sendMessage({ type: "DOWNLOAD_COMPLETE", done, failed, failures, asZip: true }).catch(() => {});
  };
  return report;
}

// ---- Preferred path: one zip, built incrementally in an offscreen document
//
// v2.4.x built the whole zip here in the service worker and only then
// shipped it to the offscreen document -- on the real 466-file course page
// that meant 1GB+ of PDFs held in the worker at once, plus a second full
// copy for the finished zip, which failed and dropped into the split
// fallback below. Now each file goes to the offscreen document as soon as
// it's fetched (see offscreen.js), so the worker only ever holds one file.
let offscreenDocumentReady = null;

async function ensureOffscreenDocument() {
  if (await chrome.offscreen.hasDocument()) return;
  if (!offscreenDocumentReady) {
    offscreenDocumentReady = chrome.offscreen
      .createDocument({
        url: "offscreen.html",
        reasons: ["BLOBS"],
        justification: "Build the combined zip file as a Blob so chrome.downloads.download can save it.",
      })
      .finally(() => {
        offscreenDocumentReady = null;
      });
  }
  await offscreenDocumentReady;
}

// Each slice is a multiple of 4 characters, so it's valid base64 on its own
// and the offscreen side can decode it independently. Keeps every message
// well under extension messaging's size limit (see the v2.4.1 note).
const ZIP_TRANSFER_CHUNK_CHARS = 4 * 1024 * 1024;

function connectOffscreenZip() {
  const port = chrome.runtime.connect({ name: "bulk-pdf-downloader-zip" });
  const waiting = new Map();
  let nextId = 1;
  let disconnected = false;

  port.onMessage.addListener((msg) => {
    const pending = waiting.get(msg.replyTo);
    if (!pending) return;
    waiting.delete(msg.replyTo);
    if (msg.ok) pending.resolve(msg);
    else pending.reject(new Error(msg.error || "offscreen zip error"));
  });
  port.onDisconnect.addListener(() => {
    disconnected = true;
    const err = new Error("offscreen document disconnected");
    waiting.forEach((pending) => pending.reject(err));
    waiting.clear();
  });

  const request = (message) =>
    new Promise((resolve, reject) => {
      if (disconnected) {
        reject(new Error("offscreen document disconnected"));
        return;
      }
      const id = nextId++;
      waiting.set(id, { resolve, reject });
      port.postMessage({ ...message, id });
    });

  return {
    ping: () => request({ type: "PING" }),
    async addFile(name, base64) {
      for (let i = 0; i < base64.length; i += ZIP_TRANSFER_CHUNK_CHARS) {
        await request({ type: "FILE_CHUNK", base64: base64.slice(i, i + ZIP_TRANSFER_CHUNK_CHARS) });
      }
      return request({ type: "FILE_END", name });
    },
    finish: () => request({ type: "FINISH" }),
    close: () => port.disconnect(),
  };
}

// The finished zip's blob: URL has to stay alive until the download manager
// has finished reading it -- for a 1GB+ file that's well past any fixed
// delay. So the URL is remembered (in storage.session, which survives the
// service worker being suspended mid-download) and released from a
// top-level downloads.onChanged listener once the download completes or is
// interrupted. Closing the offscreen document frees the blob in one go.
const PENDING_BLOB_KEY = "pendingBlobDownloads";
let activeZipRuns = 0;

async function closeOffscreenIfIdle() {
  if (activeZipRuns > 0) return;
  const stored = (await chrome.storage.session.get(PENDING_BLOB_KEY))[PENDING_BLOB_KEY] || {};
  if (Object.keys(stored).length > 0) return;
  if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument().catch(() => {});
}

async function releaseBlobDownload(downloadId) {
  const stored = (await chrome.storage.session.get(PENDING_BLOB_KEY))[PENDING_BLOB_KEY] || {};
  const url = stored[downloadId];
  if (!url) return;
  delete stored[downloadId];
  await chrome.storage.session.set({ [PENDING_BLOB_KEY]: stored });
  chrome.runtime.sendMessage({ type: "OFFSCREEN_REVOKE_BLOB_URL", url }).catch(() => {});
  await closeOffscreenIfIdle();
}

async function rememberBlobDownload(downloadId, url) {
  const stored = (await chrome.storage.session.get(PENDING_BLOB_KEY))[PENDING_BLOB_KEY] || {};
  stored[downloadId] = url;
  await chrome.storage.session.set({ [PENDING_BLOB_KEY]: stored });
  // A small zip can finish before the line above lands -- catch that case.
  const [info] = await chrome.downloads.search({ id: downloadId });
  if (!info || info.state !== "in_progress") await releaseBlobDownload(downloadId);
}

chrome.downloads.onChanged.addListener((delta) => {
  const state = delta.state && delta.state.current;
  if (state === "complete" || state === "interrupted") releaseBlobDownload(delta.id).catch(() => {});
});

// Returns a connected zip session, or null if this browser can't do the
// offscreen route (no chrome.offscreen, or the document won't start).
async function openOffscreenZip() {
  if (!chrome.offscreen) return null;
  try {
    await ensureOffscreenDocument();
    const zip = connectOffscreenZip();
    await zip.ping();
    return zip;
  } catch (e) {
    console.warn("Bulk PDF Downloader: offscreen document unavailable, falling back to split data: URLs", e);
    return null;
  }
}

async function zipViaOffscreen(zip, files, tabId, zipBase, report) {
  let added = 0;
  for (const file of files) {
    const result = await fetchFileBase64InTab(tabId, file);
    if (result.ok) {
      await zip.addFile(folderPrefix(file) + file.filename, result.base64);
      added += 1;
    }
    report.fileDone(file, result);
  }
  if (added === 0) return;

  report.saving();
  const { url } = await zip.finish();
  const downloadId = await startDownload(url, `${SUBFOLDER}/${zipBase}.zip`);
  await rememberBlobDownload(downloadId, url);
}

// ---- Fallback: split data: URL zips, one (or more) per category
//
// Only used where chrome.offscreen isn't available. A base64 data: URL
// works everywhere chrome.downloads.download runs, but doesn't scale to a
// large combined zip -- one giant JS string blows past the engine's max
// string length (confirmed live: "RangeError: Invalid string length"). So
// this writes one zip per top-level folder ("<course> - Year 1.zip"),
// further split into "(part N)" pieces only if one category alone passes
// the size cap. Every entry keeps its full folder path, so extracting all
// the parts into one place rebuilds the same tree as the single zip.
const MAX_ZIP_PART_BYTES = 60 * 1024 * 1024; // ~60MB of file data per zip part

function topFolder(file) {
  return (file.folder || file.classFolder || "").split("/")[0];
}

async function downloadBlobViaDataUrl(blob, filename) {
  const zipBytes = new Uint8Array(await blob.arrayBuffer());
  await startDownload(`data:application/zip;base64,${bytesToBase64(zipBytes)}`, filename);
}

async function zipViaDataUrls(files, tabId, zipBase, report) {
  let writer = new ZipWriter();
  let category = null;
  let partNo = 1;
  let partBytes = 0;

  const flush = async (sameCategoryContinues) => {
    if (writer.count === 0) return;
    const label = category ? `${zipBase} - ${category}` : zipBase;
    const suffix = sameCategoryContinues || partNo > 1 ? ` (part ${partNo})` : "";
    await downloadBlobViaDataUrl(writer.finish(), `${SUBFOLDER}/${label}${suffix}.zip`);
    writer = new ZipWriter();
    partBytes = 0;
    partNo = sameCategoryContinues ? partNo + 1 : 1;
  };

  for (const file of files) {
    const result = await fetchFileBase64InTab(tabId, file);
    if (result.ok) {
      const data = base64ToBytes(result.base64);
      const top = topFolder(file);
      if (writer.count > 0 && top !== category) await flush(false);
      else if (writer.count > 0 && partBytes + data.length > MAX_ZIP_PART_BYTES) await flush(true);
      category = top;
      writer.add(folderPrefix(file) + file.filename, [data]);
      partBytes += data.length;
    }
    report.fileDone(file, result);
  }
  report.saving();
  await flush(false);
}

function sanitizeZipBase(name) {
  const clean = (name || "")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "")
    .slice(0, 120);
  return clean || `BulkPDFDownloader-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

async function downloadAsZip(files, tabId, zipName) {
  const zipBase = sanitizeZipBase(zipName);
  const report = makeZipReporter(files.length);
  const zip = await openOffscreenZip();

  if (zip) {
    activeZipRuns += 1;
    try {
      await zipViaOffscreen(zip, files, tabId, zipBase, report);
    } finally {
      activeZipRuns -= 1;
      zip.close();
      closeOffscreenIfIdle().catch(() => {});
    }
  } else {
    await zipViaDataUrls(files, tabId, zipBase, report);
  }

  report.complete();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "DOWNLOAD_PDFS") return;

  const files = message.files || [];
  const run = message.asZip ? downloadAsZip(files, message.tabId, message.zipName) : downloadIndividually(files);
  run.catch((e) => {
    console.error("Bulk PDF Downloader: download run crashed", e);
    chrome.runtime
      .sendMessage({
        type: "DOWNLOAD_COMPLETE",
        done: 0,
        failed: files.length,
        failures: [],
        asZip: !!message.asZip,
        error: String((e && e.message) || e),
      })
      .catch(() => {});
  });

  sendResponse({ started: true });
  return true;
});
