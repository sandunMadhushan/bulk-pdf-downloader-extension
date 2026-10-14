// ---- Generic page scan (v1 behavior, extended in v2.1/2.2 for LMS pages) --
// Runs inside the target page. Must be fully self-contained (no outside
// references) because chrome.scripting.executeScript injects it as-is.
function scanPageForPdfs() {
  function isPdfUrl(url) {
    const clean = url.split("#")[0].split("?")[0];
    return clean.toLowerCase().endsWith(".pdf");
  }

  // CONFIRMED against a live Moodle 4.x/Boost course page (real console
  // output) that class-name matching (anything starting with "activity")
  // is NOT reliable: the title wrapper itself uses classes like
  // "activityname" / "activitytitle", which also start with "activity" and
  // sit BETWEEN the link and the actual shared container -- so matching by
  // class prefix stops one or two levels too early, before ever reaching
  // an ancestor that has the icon as a descendant. The icon
  // (div.activity-icon) and the title (div.activity-name-area) are
  // siblings under a common wrapper (div.activity-grid) several levels up;
  // there's no reliable class name to target directly across themes, so
  // instead walk up until an ancestor actually *contains* an <img>
  // anywhere inside it -- structural, not name-based, so it isn't tripped
  // up by any particular theme's class-naming scheme.
  function findIconContainer(el) {
    let node = el;
    for (let d = 0; node && d < 10; d++, node = node.parentElement) {
      if (node.querySelector && node.querySelector("img[src]")) return node;
    }
    return null;
  }

  function hasPdfIcon(a) {
    const container = findIconContainer(a) || a;
    const img = container.querySelector("img[src]");
    if (!img) return false;
    // Use the URL's pathname, not the raw src string -- Moodle's icon URLs
    // often carry a query string (e.g. ".../f/pdf?filtericon=1") that a
    // plain substring/regex check on the full src can trip over.
    let path;
    try {
      path = new URL(img.src, location.href).pathname;
    } catch (e) {
      path = img.src || "";
    }
    if (/\/f\/pdf(?:[-_.]|$)/i.test(path)) return true;
    const alt = (img.alt || "").toLowerCase();
    return /\bpdf\b/i.test(alt);
  }

  // Moodle appends screen-reader-only text to activity links (e.g.
  // `<span class="accesshide"> File</span>`), which would otherwise leak
  // into the suggested filename as a trailing "File"/"Folder"/etc.
  function cleanLabel(a) {
    const clone = a.cloneNode(true);
    clone.querySelectorAll(".accesshide, .sr-only, .visually-hidden").forEach((n) => n.remove());
    return clone.textContent.replace(/\s+/g, " ").trim();
  }

  // CONFIRMED against a live Moodle 4.x course page (lms.aps.rjt.ac.lk, the
  // 466-PDF "E-Library - Department of Computing" course): every activity
  // sits inside `<li class="section" data-sectionname="...">`, and the
  // attribute holds the clean section title (the visible heading also
  // carries "Collapse"/"Expand" button text). All enclosing sections are
  // collected, outermost first, so Moodle 4.5+ nested subsections become
  // nested folders too.
  function sectionNames(el) {
    const names = [];
    const SECTION = "li.section, [data-sectionname]";
    for (let node = el.closest(SECTION); node; node = node.parentElement && node.parentElement.closest(SECTION)) {
      let name = node.getAttribute("data-sectionname");
      if (!name) {
        const title = node.querySelector(".sectionname, [data-for='section_title']");
        if (title) name = cleanLabel(title);
      }
      if (name && name.trim()) names.unshift(name.replace(/\s+/g, " ").trim());
    }
    return names;
  }

  // CONFIRMED on the same page: a section's own title link sits in the
  // section header, and walking up from it reaches the whole section --
  // which contains the PDF icons of the files inside it. So every section
  // title was being picked up as a "PDF" (57 bogus entries out of 523,
  // each of which then failed as an HTML page). Section headers and the
  // course-index drawer only ever link to sections/activities that also
  // appear in the main content, so they're skipped for icon detection.
  const NOT_A_FILE_LINK = ".sectionname, [data-for='section_title'], .course-section-header, .courseindex";

  const found = new Map();

  // The same resource can be linked twice (e.g. Moodle's course-index
  // drawer and the main course content) -- keep whichever copy knows its
  // section, and the first non-empty label.
  function addFound(url, label, sections) {
    const existing = found.get(url);
    if (!existing) {
      found.set(url, { url, label, sections });
      return;
    }
    if (!existing.label && label) existing.label = label;
    if (existing.sections.length === 0 && sections.length > 0) existing.sections = sections;
  }

  document.querySelectorAll("a[href]").forEach((a) => {
    let url;
    try {
      url = new URL(a.getAttribute("href"), location.href).href;
    } catch (e) {
      return; // ignore malformed URLs
    }
    const label = cleanLabel(a);
    if (isPdfUrl(url)) {
      addFound(url, label || decodeURIComponent(url.split("/").pop()), sectionNames(a));
    } else if (label && !a.closest(NOT_A_FILE_LINK) && hasPdfIcon(a)) {
      // e.g. a Moodle "mod/resource/view.php?id=123" wrapper link
      addFound(url, label, sectionNames(a));
    }
  });

  document.querySelectorAll("embed[src], object[data], iframe[src]").forEach((el) => {
    const raw = el.getAttribute("src") || el.getAttribute("data");
    if (!raw) return;
    try {
      const url = new URL(raw, location.href).href;
      if (isPdfUrl(url) && !found.has(url)) {
        addFound(url, decodeURIComponent(url.split("/").pop()), sectionNames(el));
      }
    } catch (e) {
      /* ignore */
    }
  });

  // Used to name the combined zip, e.g. "E-Library - Department of Computing.zip".
  const heading = document.querySelector(".page-header-headings h1, #page-header h1, h1");
  const title = (heading && heading.textContent.replace(/\s+/g, " ").trim()) || document.title || "";

  return { title, items: Array.from(found.values()) };
}

// ---- Folder layout from Moodle section names --------------------------------
// The past-paper course this was built against has ~60 flat sections whose
// names carry the whole hierarchy, in many inconsistent spellings:
//   "B.Sc in Applied Sciences First Year - Semester II Examination - Oct / Nov 2025"
//   "B.Sc. (Four- year) Degree in Applied Sciences Fourth Year - Semester - I Examination - September/October 2019"
//   "... First Year - Pre Semester Examination - Oct 2024"
//   "... Second Year Semester - II Examination April/May 2015 & Semester - I Examination October/November 2015"
// Those become  Year 1/Semester 2/2025 Oct-Nov,  Year 4/Semester 1/2019 Sep-Oct,
// Year 1/Pre Semester/2024 Oct,  Year 2/Semester 1 & 2/2015 Apr-May & Oct-Nov.
// A section name that doesn't look like an exam sitting (no study year or
// semester, or no exam date) is used as a single folder as-is, so ordinary
// courses ("Week 1", "Topic 3") still get one folder per section.
const STUDY_YEAR_WORDS = { first: 1, "1st": 1, second: 2, "2nd": 2, third: 3, "3rd": 3, fourth: 4, "4th": 4, fifth: 5, "5th": 5 };
const MONTH_NAMES = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];
const ROMAN_NUMERALS = { i: 1, ii: 2, iii: 3, iv: 4 };

function parseStudyYear(text) {
  let m = text.match(/\b(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)\s*-?\s*year\b/i);
  if (m) return STUDY_YEAR_WORDS[m[1].toLowerCase()];
  m = text.match(/\b(?:year|level)\s*-?\s*([1-5])\b/i);
  return m ? Number(m[1]) : null;
}

// 0 = pre-semester, 1..4 = semester number, null = not mentioned.
function parseSemester(text) {
  if (/\bpre[\s-]*semester\b/i.test(text)) return 0;
  let m = text.match(/\bsemester\s*[-:]?\s*(iv|iii|ii|i|[1-4])\b/i);
  if (m) return ROMAN_NUMERALS[m[1].toLowerCase()] || Number(m[1]);
  m = text.match(/\b(first|second|1st|2nd)\s+semester\b/i);
  return m ? STUDY_YEAR_WORDS[m[1].toLowerCase()] : null;
}

// Month words are matched as prefixes of the full name so the course's
// abbreviations ("Nove", "Dece", "Sept", "Mar") all count.
function parseSession(text) {
  const years = text.match(/\b(?:19|20)\d{2}\b/g);
  const months = [];
  for (const word of text.match(/[a-z]+/gi) || []) {
    if (word.length < 3) continue;
    const index = MONTH_NAMES.findIndex((month) => month.startsWith(word.toLowerCase()));
    if (index < 0) continue;
    const label = MONTH_NAMES[index][0].toUpperCase() + MONTH_NAMES[index].slice(1, 3);
    if (months[months.length - 1] !== label) months.push(label);
  }
  return { year: years ? years[years.length - 1] : null, months };
}

function semesterLabel(semesters) {
  if (semesters.length === 1) return semesters[0] === 0 ? "Pre Semester" : `Semester ${semesters[0]}`;
  const numbered = semesters.filter((s) => s > 0);
  const parts = [];
  if (semesters.includes(0)) parts.push("Pre Semester");
  if (numbered.length) parts.push(`Semester ${numbered.join(" & ")}`);
  return parts.join(" & ");
}

function sessionLabel(sessions) {
  const known = sessions.filter((s) => s.year || s.months.length);
  if (known.length === 0) return null;
  const years = [...new Set(known.map((s) => s.year).filter(Boolean))];
  if (years.length <= 1) {
    const months = known.map((s) => s.months.join("-")).filter(Boolean).join(" & ");
    return [years[0], months].filter(Boolean).join(" ");
  }
  return known.map((s) => [s.year, s.months.join("-")].filter(Boolean).join(" ")).join(" & ");
}

function sanitizeFolderName(name) {
  return name
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "")
    .slice(0, 100);
}

function foldersForSection(name) {
  const studyYear = parseStudyYear(name);
  // Combined sittings ("Semester II ... 2015 & Semester I ... 2015") are
  // parsed per "&"-separated part so each keeps its own semester and date.
  const parts = name.split("&").map((part) => ({ semester: parseSemester(part), session: parseSession(part) }));
  const semesters = [...new Set(parts.map((p) => p.semester).filter((s) => s !== null))].sort((a, b) => a - b);
  const session = sessionLabel(parts.map((p) => p.session));

  if ((studyYear === null && semesters.length === 0) || !session) return [sanitizeFolderName(name)];

  const folders = [];
  if (studyYear !== null) folders.push(`Year ${studyYear}`);
  if (semesters.length) folders.push(semesterLabel(semesters));
  folders.push(session);
  return folders.map(sanitizeFolderName);
}

function folderPathForSections(sections) {
  return sections
    .flatMap(foldersForSection)
    .filter(Boolean)
    .join("/");
}

// ---- Shared UI state ----------------------------------------------------
const listEl = document.getElementById("pdfList");
const emptyStateEl = document.getElementById("emptyState");
const selectAllEl = document.getElementById("selectAllCheckbox");
const countLabelEl = document.getElementById("countLabel");
const filterEl = document.getElementById("filterInput");
const downloadBtn = document.getElementById("downloadBtn");
const statusEl = document.getElementById("statusText");
const rescanBtn = document.getElementById("rescanBtn");
const titleEl = document.getElementById("titleText");
const typeChipsEl = document.getElementById("typeChips");
const deepScanBtn = document.getElementById("deepScanBtn");
const failuresBox = document.getElementById("failuresBox");
const failuresHeading = document.getElementById("failuresHeading");
const failuresList = document.getElementById("failuresList");

let mode = "generic"; // 'generic' | 'classroom'
let activeTabId = null;
let items = []; // normalized: { key, filename, folder, type, postTitle, selected, payload }
let activeTypeFilter = "all";
let pageTitle = ""; // names the combined zip

function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, "_").slice(0, 150);
}

function suggestFilename(label, index) {
  let base = label && label.length > 0 ? label : `document-${index + 1}`;
  if (!base.toLowerCase().endsWith(".pdf")) base += ".pdf";
  return sanitizeFilename(base);
}

// ---- Rendering ------------------------------------------------------------
function badgeLabel(type) {
  return { pdf: "PDF", doc: "Doc", slides: "Slides", sheet: "Sheet", unknown: "Other" }[type] || "";
}

function render() {
  const filterText = filterEl.value.trim().toLowerCase();
  listEl.innerHTML = "";

  const visible = items.filter((it) => {
    if (activeTypeFilter !== "all" && it.type !== activeTypeFilter) return false;
    if (filterText && !`${it.folder}/${it.filename}`.toLowerCase().includes(filterText)) return false;
    return true;
  });

  emptyStateEl.style.display = items.length === 0 ? "block" : "none";
  emptyStateEl.textContent =
    items.length === 0
      ? mode === "classroom"
        ? "No PDFs/Docs found yet — try Deep scan to load lazy content."
        : "No PDF links found on this page."
      : "No matches.";
  if (items.length > 0 && visible.length === 0) emptyStateEl.style.display = "block";

  visible.forEach((item) => {
    const li = document.createElement("li");

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = item.selected;
    checkbox.addEventListener("change", () => {
      item.selected = checkbox.checked;
      updateFooterAndSelectAll();
    });

    const meta = document.createElement("div");
    meta.className = "pdfMeta";

    const nameRow = document.createElement("span");
    nameRow.className = "pdfName";
    nameRow.textContent = item.filename;
    nameRow.title = item.filename;
    if (item.type) {
      const badge = document.createElement("span");
      badge.className = `pdfBadge ${item.type}`;
      badge.textContent = badgeLabel(item.type);
      nameRow.appendChild(badge);
    }

    const subLine = document.createElement("span");
    subLine.className = mode === "classroom" || item.folder ? "pdfPostTitle" : "pdfUrl";
    subLine.textContent =
      mode === "classroom" ? item.postTitle || "" : item.folder.replace(/\//g, " › ") || item.payload.url || "";
    subLine.title = subLine.textContent;

    meta.appendChild(nameRow);
    meta.appendChild(subLine);
    li.appendChild(checkbox);
    li.appendChild(meta);
    listEl.appendChild(li);
  });

  countLabelEl.textContent = `${items.length} file${items.length === 1 ? "" : "s"} found`;
}

function updateFooterAndSelectAll() {
  const visible = items.filter((it) => activeTypeFilter === "all" || it.type === activeTypeFilter);
  const selectedCount = items.filter((it) => it.selected).length;
  downloadBtn.textContent = `Download selected (${selectedCount})`;
  downloadBtn.disabled = selectedCount === 0;
  const visSelected = visible.filter((it) => it.selected).length;
  selectAllEl.checked = visible.length > 0 && visSelected === visible.length;
  selectAllEl.indeterminate = visSelected > 0 && visSelected < visible.length;
}

// ---- Generic-page scanning ------------------------------------------------
async function scanGeneric(tab) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: scanPageForPdfs,
  });
  const scan = (result && result.result) || { title: "", items: [] };
  pageTitle = scan.title;
  items = scan.items.map((f, i) => {
    const filename = suggestFilename(f.label, i);
    const folder = folderPathForSections(f.sections || []);
    return {
      key: f.url,
      filename,
      folder,
      type: "pdf",
      postTitle: "",
      selected: true,
      payload: { url: f.url, filename, folder, viewUrl: f.url },
    };
  });
}

// ---- Classroom scanning ----------------------------------------------------
function toClassroomItems(rawItems) {
  return rawItems.map((r) => ({
    key: r.id,
    filename: r.filename,
    folder: "",
    type: r.type,
    postTitle: r.postTitle,
    selected: r.type !== "unknown", // unknown files unselected by default -- may not be PDFs
    payload: {
      id: r.id,
      type: r.type,
      filename: r.filename,
      classFolder: r.className,
      viewUrl: `https://drive.google.com/file/d/${r.id}/view`,
    },
  }));
}

async function scanClassroom(tab, deep) {
  const messageType = deep ? "CLASSROOM_DEEP_SCAN" : "CLASSROOM_QUICK_SCAN";
  if (deep) {
    deepScanBtn.disabled = true;
    statusEl.textContent = "Expanding and scrolling the page…";
  }
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: messageType });
    items = toClassroomItems((response && response.items) || []);
  } catch (e) {
    // Content script may not have loaded yet (e.g. page just navigated) --
    // fall back to whatever was last cached for this tab, if anything.
    statusEl.textContent = "Couldn't reach the page scanner — try Deep scan.";
  }
  if (deep) deepScanBtn.disabled = false;
}

// ---- Boot / mode detection --------------------------------------------------
async function boot() {
  statusEl.textContent = "";
  emptyStateEl.style.display = "block";
  emptyStateEl.textContent = "Scanning page…";
  listEl.innerHTML = "";
  items = [];
  failuresBox.classList.add("hidden");
  downloadBtn.disabled = true;
  downloadBtn.textContent = "Download selected (0)";

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    statusEl.textContent = "No active tab.";
    return;
  }
  activeTabId = tab.id;

  let hostname = "";
  try {
    hostname = new URL(tab.url || "").hostname;
  } catch {
    /* ignore */
  }

  if (hostname === "classroom.google.com") {
    mode = "classroom";
    titleEl.textContent = "Bulk PDF Grabber — Classroom";
    typeChipsEl.classList.remove("hidden");
    deepScanBtn.classList.remove("hidden");
    await scanClassroom(tab, false);
  } else {
    mode = "generic";
    titleEl.textContent = "Bulk PDF Grabber";
    typeChipsEl.classList.add("hidden");
    deepScanBtn.classList.add("hidden");
    if (!/^https?:/i.test(tab.url || "")) {
      emptyStateEl.textContent = "This page can't be scanned (not http/https).";
      return;
    }
    try {
      await scanGeneric(tab);
    } catch (e) {
      emptyStateEl.textContent = "Couldn't scan this page (permissions or restricted URL).";
      statusEl.textContent = String(e.message || e);
      return;
    }
  }

  render();
  updateFooterAndSelectAll();
}

// ---- Event wiring -----------------------------------------------------------
selectAllEl.addEventListener("change", () => {
  const visible = items.filter((it) => activeTypeFilter === "all" || it.type === activeTypeFilter);
  visible.forEach((it) => (it.selected = selectAllEl.checked));
  render();
  updateFooterAndSelectAll();
});

filterEl.addEventListener("input", render);
rescanBtn.addEventListener("click", boot);

deepScanBtn.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  await scanClassroom(tab, true);
  render();
  updateFooterAndSelectAll();
  statusEl.textContent = `Deep scan complete — ${items.length} file(s) found.`;
});

typeChipsEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".chip");
  if (!btn) return;
  typeChipsEl.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
  btn.classList.add("active");
  activeTypeFilter = btn.dataset.type;
  render();
  updateFooterAndSelectAll();
});

// 10+ files download as a single .zip instead of N separate files. Bundling
// needs the actual bytes, not just a save-to-disk trigger -- background.js
// gets those by running a fetch() *inside the scanned tab* (via
// chrome.scripting.executeScript), so the file has to be same-origin to
// that tab or it'd hit the same cross-origin restrictions a page's own
// script would. That's only guaranteed for generic-page (incl. Moodle)
// items, which is exactly what `mode === "generic"` covers -- Classroom
// items point at drive.google.com/docs.google.com, a different origin from
// the classroom.google.com tab they were scanned from, so those keep using
// the existing per-file chrome.downloads.download() path unconditionally.
const ZIP_THRESHOLD = 10;

downloadBtn.addEventListener("click", async () => {
  const selected = items.filter((it) => it.selected);
  if (selected.length === 0) return;
  downloadBtn.disabled = true;
  failuresBox.classList.add("hidden");

  const payloads = selected.map((it) => it.payload);
  const asZip = mode === "generic" && selected.length >= ZIP_THRESHOLD;

  statusEl.textContent = asZip
    ? `Fetching 0 / ${selected.length} for zip…`
    : `Downloading 0 / ${selected.length}…`;
  chrome.runtime.sendMessage(
    { type: "DOWNLOAD_PDFS", files: payloads, asZip, tabId: activeTabId, zipName: pageTitle },
    () => {}
  );
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === "DOWNLOAD_PROGRESS") {
    statusEl.textContent =
      msg.stage === "saving"
        ? "Saving zip…"
        : msg.asZip
          ? `Fetching ${msg.done} / ${msg.total} for zip…`
          : `Downloading ${msg.done} / ${msg.total}…`;
  } else if (msg.type === "DOWNLOAD_COMPLETE") {
    const succeeded = msg.done - msg.failed;
    statusEl.textContent = msg.error
      ? `Failed: ${msg.error}`
      : msg.asZip
        ? `Done — ${succeeded} file${succeeded === 1 ? "" : "s"} zipped${msg.failed ? `, ${msg.failed} failed` : ""}.`
        : `Done — ${succeeded} saved${msg.failed ? `, ${msg.failed} failed` : ""}.`;
    updateFooterAndSelectAll();

    if (msg.failed > 0 && msg.failures && msg.failures.length) {
      failuresBox.classList.remove("hidden");
      failuresHeading.textContent = `${msg.failed} file(s) need manual download:`;
      failuresList.innerHTML = "";
      msg.failures.forEach((f) => {
        const li = document.createElement("li");
        if (f.viewUrl) {
          const a = document.createElement("a");
          a.href = "#";
          a.textContent = f.filename;
          a.title = "Open in Drive so you can save it manually";
          a.addEventListener("click", (e) => {
            e.preventDefault();
            chrome.tabs.create({ url: f.viewUrl });
          });
          li.appendChild(a);
        } else {
          li.textContent = f.filename;
        }
        li.append(` — ${f.reason === "interstitial" ? "Drive blocked automatic download" : f.reason || "failed"}`);
        failuresList.appendChild(li);
      });
    }
  } else if (msg.type === "CLASSROOM_SCAN_PROGRESS" && mode === "classroom") {
    if (msg.status === "expanding") statusEl.textContent = "Expanding collapsed sections…";
    else if (msg.status === "scrolling") statusEl.textContent = "Scrolling to load more posts…";
  } else if (
    msg.type === "CLASSROOM_ITEMS_UPDATED" &&
    mode === "classroom" &&
    sender.tab &&
    sender.tab.id === activeTabId
  ) {
    // Live update while the popup is open and Classroom's own MutationObserver
    // picks up newly rendered content (e.g. user scrolling manually).
    items = toClassroomItems(msg.items);
    render();
    updateFooterAndSelectAll();
  }
});

boot();
