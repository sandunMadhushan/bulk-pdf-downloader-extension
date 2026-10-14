// Runs automatically on any classroom.google.com page (declared in manifest,
// scoped to that host only). Finds Drive/Docs/Slides/Sheets attachment links,
// classifies them, and keeps the popup's cache up to date.
//
// NOTE FOR THE DEVELOPER: Classroom's CSS class names are minified and change
// between deploys, so this deliberately avoids depending on any of them.
// Detection instead relies on:
//   - the URL shape (/file/d/<id>/, /document/d/<id>/, etc.) — stable, part
//     of Google's public Drive/Docs API surface
//   - aria-expanded / role="button" — accessibility attributes Google keeps
//     stable because screen readers depend on them
//   - role="heading" / aria-level / <h1-6> — same reasoning
// If detection misses things on your real Classroom pages, run
// `window.__pdfDownloaderDebug()` in the page console (see bottom of file) to
// see exactly what the scanner is seeing, then tighten the heuristics below.

(() => {
  if (window.__pdfDownloaderClassroomInstalled) return;
  window.__pdfDownloaderClassroomInstalled = true;

  const FILE_REF_PATTERNS = [
    { re: /\/file\/d\/([a-zA-Z0-9_-]+)/, kind: "drive" },
    { re: /\/open\?[^#]*[?&]id=([a-zA-Z0-9_-]+)/, kind: "drive" },
    { re: /\/document\/d\/([a-zA-Z0-9_-]+)/, kind: "doc" },
    { re: /\/presentation\/d\/([a-zA-Z0-9_-]+)/, kind: "slides" },
    { re: /\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/, kind: "sheet" },
  ];

  // Toggle-looking elements it's safe to auto-click while expanding the page.
  // Deliberately excludes anything that sounds like it submits, deletes, or
  // changes state rather than just showing/hiding content.
  const UNSAFE_LABEL_WORDS =
    /submit|turn in|unsubmit|delete|remove|unenroll|leave class|mark as done|resubmit|archive/i;

  function extractFileRef(href) {
    for (const { re, kind } of FILE_REF_PATTERNS) {
      const m = href.match(re);
      if (m) return { id: m[1], kind };
    }
    return null;
  }

  function sanitize(name) {
    return name.replace(/[\\/:*?"<>|]/g, "_").trim().slice(0, 150);
  }

  // CONFIRMED against a live Classroom Stream page: the attachment <a> itself
  // carries an aria-label of the form "Attachment: <TYPE>: <filename>", e.g.
  // `aria-label="Attachment: PDF: ICT3215 Quiz Group Allocation.pdf"`. This is
  // far more reliable than guessing from an icon's image URL, so it's the
  // primary signal now. The icon path (e.g.
  // ".../mediatype/icon_3_pdf_x32.png") is kept as a fallback in case a given
  // attachment ever lacks the aria-label.
  const ARIA_LABEL_RE = /^Attachment:\s*([^:]+):\s*(.+)$/i;

  function parseAriaLabel(anchorEl) {
    const label = anchorEl.getAttribute("aria-label") || "";
    const m = label.match(ARIA_LABEL_RE);
    if (!m) return null;
    return { typeLabel: m[1].trim().toLowerCase(), filename: m[2].trim() };
  }

  function typeFromLabel(typeLabel) {
    if (!typeLabel) return null;
    if (/pdf/.test(typeLabel)) return "pdf";
    if (/doc/.test(typeLabel)) return "doc"; // "Google Docs" / "Doc"
    if (/slide/.test(typeLabel)) return "slides";
    if (/sheet/.test(typeLabel)) return "sheet";
    return null; // image, video, zip, etc. -- not something we auto-classify
  }

  // Fallback for attachments with no usable aria-label: inspect the nearby
  // icon's image URL for a mimetype/media-type hint.
  function guessTypeFromIcon(anchorEl) {
    const card =
      anchorEl.closest('[role="listitem"], li, div[role="button"]') ||
      anchorEl.parentElement ||
      anchorEl;
    const img = card.querySelector?.("img[src]");
    if (!img) return "unknown";
    const src = img.src || "";
    if (/mediatype\/icon_3_pdf|application%2Fpdf|application\/pdf/i.test(src)) return "pdf";
    if (/vnd\.google-apps\.document/i.test(src)) return "doc";
    if (/vnd\.google-apps\.presentation/i.test(src)) return "slides";
    if (/vnd\.google-apps\.spreadsheet/i.test(src)) return "sheet";
    return "unknown";
  }

  function classContext() {
    // The class name usually appears in the page <title>, e.g. "Stream - My Class"
    const title = document.title || "";
    const parts = title.split(/[-–|]/).map((p) => p.trim()).filter(Boolean);
    return parts.length > 1 ? parts[parts.length - 1] : parts[0] || "Classroom";
  }

  // CONFIRMED against a live Classroom Stream page: post captions are NOT
  // marked up with role="heading" or <h1-6> -- they're plain text siblings
  // of the attachment card grid. The reliable way to find one is to walk up
  // from the attachment link and take the first ancestor whose text content
  // (with any nested attachment-link text stripped out) is non-empty --
  // that's consistently the post's caption/body, one level above the
  // attachment card grid, verified on both single- and multi-attachment
  // posts.
  function nearestCaptionText(el) {
    let node = el.parentElement;
    for (let depth = 0; node && depth < 10; depth++, node = node.parentElement) {
      const clone = node.cloneNode(true);
      clone.querySelectorAll('a[aria-label^="Attachment"]').forEach((n) => n.remove());
      const text = clone.textContent.replace(/\s+/g, " ").trim();
      if (text.length > 0) {
        // Guard against walking too far and grabbing the whole post's
        // metadata block ("Post by ... Created ... visible to ...").
        if (/^Post by /i.test(text)) return null;
        return text.length > 120 ? text.slice(0, 117) + "…" : text;
      }
    }
    return null;
  }

  function guessType(anchorEl, ref, parsedLabel) {
    if (ref.kind !== "drive") return ref.kind; // doc/slides/sheet already certain from URL
    const fromLabel = parsedLabel && typeFromLabel(parsedLabel.typeLabel);
    return fromLabel || guessTypeFromIcon(anchorEl);
  }

  function displayName(anchorEl, ref, type, parsedLabel) {
    let base = parsedLabel?.filename || (anchorEl.textContent || "").trim();
    if (!base) base = `attachment-${ref.id.slice(0, 8)}`;
    base = base.replace(/\.pdf$/i, "");
    const ext = type === "unknown" ? "" : ".pdf";
    return sanitize(base) + ext;
  }

  function collect() {
    const found = new Map();
    document.querySelectorAll("a[href]").forEach((a) => {
      let href;
      try {
        href = new URL(a.getAttribute("href"), location.href).href;
      } catch {
        return;
      }
      const ref = extractFileRef(href);
      if (!ref) return;
      if (found.has(ref.id)) return;

      const parsedLabel = parseAriaLabel(a);
      const type = guessType(a, ref, parsedLabel);
      found.set(ref.id, {
        id: ref.id,
        kind: ref.kind,
        type, // 'pdf' | 'doc' | 'slides' | 'sheet' | 'unknown'
        postTitle: nearestCaptionText(a) || "Untitled post",
        className: classContext(),
        filename: displayName(a, ref, type, parsedLabel),
      });
    });
    return Array.from(found.values());
  }

  function report(items) {
    chrome.storage.session
      .set({ [`classroom_${location.href.split("#")[0]}`]: { items, scannedAt: Date.now() } })
      .catch(() => {});
    chrome.runtime.sendMessage({ type: "CLASSROOM_ITEMS_UPDATED", items }).catch(() => {});
  }

  let debounceTimer = null;
  function scheduleCollect() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => report(collect()), 400);
  }

  const observer = new MutationObserver(scheduleCollect);
  observer.observe(document.body, { childList: true, subtree: true });
  scheduleCollect(); // initial pass

  // --- Deep scan: auto-expand safe toggles, then auto-scroll to force
  // lazy-loaded posts/attachments to render, then do a final collect.
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function expandSafeToggles() {
    const toggles = Array.from(
      document.querySelectorAll('[aria-expanded="false"]')
    ).slice(0, 60); // hard cap so a runaway page can't infinite-loop this

    for (const el of toggles) {
      const label = el.getAttribute("aria-label") || el.textContent || "";
      if (UNSAFE_LABEL_WORDS.test(label)) continue;
      try {
        el.click();
        await sleep(120);
      } catch {
        /* ignore */
      }
    }
  }

  async function autoScroll(maxMs = 15000) {
    const start = Date.now();
    let lastHeight = 0;
    let stableCount = 0;

    while (Date.now() - start < maxMs && stableCount < 3) {
      window.scrollBy(0, window.innerHeight * 0.85);
      await sleep(500);
      const height = document.body.scrollHeight;
      if (height === lastHeight) {
        stableCount += 1;
      } else {
        stableCount = 0;
        lastHeight = height;
      }
    }
    window.scrollTo(0, 0);
  }

  async function deepScan() {
    chrome.runtime.sendMessage({ type: "CLASSROOM_SCAN_PROGRESS", status: "expanding" }).catch(() => {});
    await expandSafeToggles();
    chrome.runtime.sendMessage({ type: "CLASSROOM_SCAN_PROGRESS", status: "scrolling" }).catch(() => {});
    await autoScroll();
    await expandSafeToggles(); // a second pass — scrolling often reveals new toggles
    const items = collect();
    report(items);
    chrome.runtime.sendMessage({ type: "CLASSROOM_SCAN_PROGRESS", status: "done", items }).catch(() => {});
    return items;
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "CLASSROOM_DEEP_SCAN") {
      deepScan().then((items) => sendResponse({ items }));
      return true; // keep the message channel open for the async response
    }
    if (msg.type === "CLASSROOM_QUICK_SCAN") {
      sendResponse({ items: collect() });
    }
  });

  // Debug helper — run window.__pdfDownloaderDebug() in the Classroom page's
  // console (F12) to see exactly what the scanner currently sees, and why.
  window.__pdfDownloaderDebug = () => {
    const items = collect();
    console.log(`[Bulk PDF Downloader] ${items.length} candidate file(s) found:`);
    console.table(items);
    return items;
  };
})();
