# Development notes

Internal notes for building on / publishing this extension. Not part of the
public-facing README.

## How it works

- **popup.js** injects a self-contained scan function into the active tab
  only when you open the popup (via `chrome.scripting.executeScript` +
  the `activeTab` permission) — it does **not** run on every page you visit,
  and it does not need broad `<all_urls>` host permissions.
- The scan looks at `<a href>` links, and `<embed>` / `<object>` / `<iframe>`
  elements, and keeps anything whose URL ends in `.pdf`.
- **background.js** (a service worker) receives the selected list and calls
  `chrome.downloads.download()` for each one, spaced ~350ms apart, saving
  everything into a `BulkPDFDownloader/` subfolder in your Downloads folder.

## v2: Classroom/Drive detection — validated against a live page

I was able to check this against a real Classroom class (ICT3215) via a
connected browser session. What that confirmed, and what's still inferred:

**Confirmed and now built accordingly:**

1. **File type is in the aria-label, not just the icon.** Every attachment
   link carries `aria-label="Attachment: PDF: <filename>.pdf"` (confirmed
   exact wording for PDF). `content-classroom.js` now parses this directly
   (`parseAriaLabel` / `typeFromLabel`) as the primary signal, with the old
   icon-mimetype guess kept only as a fallback for attachments that somehow
   lack the label.
2. **Post captions are plain text, not headings.** My original
   `nearestHeadingText` (looking for `role="heading"`/`<h1-6>`) would have
   returned nothing on a real page — Stream posts render their caption as
   plain sibling text next to the attachment grid, with no heading markup at
   all. Replaced with `nearestCaptionText`, which walks up from the
   attachment link and takes the first ancestor with non-empty text once
   nested attachment-link text is stripped out. Verified correct on both a
   single-attachment post and a 5-attachment post (correctly returned
   "Practical Labsheets" for all five, not five different values).
3. **Lazy loading is real and matters.** On page load, only attachments in
   posts already in the viewport exist in the DOM — scrolling down caused
   entirely new `<a aria-label="Attachment: ...">` elements to appear that
   weren't there before. This confirms the Deep scan approach (auto-scroll +
   MutationObserver) is necessary, not just defensive over-engineering.

**Still inferred, not empirically confirmed:**

- The exact aria-label wording for Google Docs/Slides/Sheets attachments
  (assumed to follow the same `"Attachment: <Type>: <filename>"` pattern,
  e.g. `"Attachment: Google Docs: ..."`, based on Google's general
  accessibility conventions, but I only had PDF attachments to check against
  in this account). If detection misses Docs/Slides/Sheets specifically,
  run `window.__pdfDownloaderDebug()` on a post that has one and check the
  actual `aria-label` string, then adjust the regex in `typeFromLabel`.
- The Classwork tab specifically — the class I checked had no assignments
  posted yet, so attachment detection there is untested (Stream attachments
  use the same underlying attachment-card component in Classroom generally,
  so it should work the same way, but worth a quick check).
- Whether Classroom ever scrolls an inner container instead of the whole
  page — I didn't hit this in my check, but `autoScroll()` still only
  scrolls `window` (see below).

**Not exercised in this check (didn't actually trigger a download or hit an
`aria-expanded` toggle):**

- The virus-scan-interstitial fallback (`drive.usercontent.google.com/
  download?id=...&export=download&confirm=t`) — still the least proven part
  of this build. `background.js` checks the completed download's MIME type
  and retries/reports failure if it got HTML instead of a PDF, and the popup
  surfaces a manual "open in Drive" link for anything that ultimately fails
  — but if failures are common, this endpoint having changed again is the
  first thing to check.
- `expandSafeToggles()`'s unsafe-word blocklist — the class I checked didn't
  have any collapsed/expandable sections to test against, so the blocklist
  (submit, delete, turn in, etc.) hasn't been exercised against real button
  labels yet.

## Known limitations

- **Moodle "Embed" display mode**: if a Moodle admin configures a resource
  to display embedded (inline PDF viewer on the resource page) rather than
  force-download, the wrapper URL might return an HTML page instead of the
  raw PDF. `background.js`'s existing MIME-type check (originally built for
  the Drive interstitial) also catches this case and reports it as a
  failure with a manual "open" link, but it hasn't been tested against a
  real Moodle instance set to Embed mode — only against `oulms.ou.ac.lk`'s
  default (which redirects straight to the file and works cleanly).
- **`mod_folder` resources** (Moodle's "Folder" activity, shown with a
  folder icon) aren't expanded — they contain multiple files behind a
  second page, out of scope for the current icon-based single-link
  detection. Worth a v3 feature if these come up often.
- **v2.1.0's Moodle icon detection was wrong, fixed in v2.2.0.** Confirmed
  against two live sites (`oulms.ou.ac.lk` and `lms.aps.rjt.ac.lk`, different
  Moodle themes) that the icon is never nested inside the resource `<a>` --
  it's a sibling several DOM levels up, inside a shared per-activity
  container (class starting with `activity`, e.g. `.activity-grid` on
  current Boost). `hasPdfIcon()` now walks up to that container before
  searching for the icon, instead of only looking inside the link. Also
  fixed: the icon `src` can carry a query string (`.../f/pdf?filtericon=1`)
  that the old regex, applied to the raw `src`, didn't handle -- now checks
  `new URL(src).pathname` instead. And: link text can include Moodle's
  screen-reader-only suffix (`<span class="accesshide"> File</span>`),
  which was leaking into suggested filenames -- `cleanLabel()` strips
  `.accesshide`/`.sr-only`/`.visually-hidden` elements before reading text.
- **v2.2.0's `findActivityContainer()` was still wrong, fixed in v2.2.1.**
  Confirmed via real DOM markup from `lms.aps.rjt.ac.lk` (Moodle 4.x/Boost):
  matching by "class name starts with `activity`" is unreliable because the
  *title* wrapper itself uses classes like `activityname` and
  `activitytitle`, which also start with `activity` and sit between the
  link and the actual shared row container (`div.activity-grid`) — so the
  walk-up stopped 2-3 levels too early, at a container that has no icon
  inside it at all (the icon is a sibling of the title's container, not a
  descendant of it). Result: `hasPdfIcon()` always returned false on this
  site, `0 files found` even though every row clearly had a PDF icon.
  Replaced with `findIconContainer()`, which ignores class names entirely
  and instead walks up until it finds an ancestor that structurally
  *contains* an `<img>` anywhere inside it — this doesn't depend on any
  particular theme's naming scheme, so it should be robust across Moodle
  versions/themes going forward.
- **Still not verified**: confirmed on Moodle Boost (current, `.activity-grid`
  structure) on two sites. Very old Moodle versions/themes (pre-Boost, using
  `<li class="activity">` markup with the icon and link as closer siblings)
  should also work with the new structural `findIconContainer()` approach,
  but haven't been checked directly.
- **Cross-origin iframes**: if a PDF is embedded inside an `<iframe>` from a
  different domain, the script can usually still read its `src` attribute,
  but it can't reach into the iframe's own DOM — so PDFs linked *inside*
  a cross-origin iframe's content (not just the iframe's own src) won't be
  found. This is a browser security boundary, not something permissions can
  fix.
- **Infinite-scroll / SPA pages**: new PDFs that load in after the popup
  opened won't appear until the user clicks rescan (⟳).
- **Chrome PDF viewer tabs**: if a PDF is already open full-page in a tab
  (URL ends in `.pdf` and Chrome's viewer is showing it), that's not a
  "page with links" — there's nothing to scan. Consider special-casing this:
  if `tab.url` itself ends in `.pdf`, just offer to download that one file
  directly instead of scanning.

## v2.3.0: zip-bundling for 10+ files

- Selecting 10+ files and clicking Download now bundles them into a single
  `.zip` (`BulkPDFDownloader/BulkPDFDownloader-<timestamp>.zip`) instead of
  triggering N separate downloads. Below that threshold, behavior is
  unchanged (N individual downloads via `chrome.downloads.download`, as
  before).
- Bundling needs the actual file *bytes*, not just a save-to-disk trigger.
  Zip mode is therefore only offered for generic-page scans
  (`mode === "generic"` in popup.js, which covers Moodle/any non-Classroom
  page) — Classroom keeps using the existing per-file
  `chrome.downloads.download()` path unconditionally, regardless of how
  many files are selected. See v2.3.3 below for why.
- The ZIP itself is written by hand in `background.js` (`buildZip()` /
  `crc32()` / `dosDateTime()`) using the "store" (no compression) method —
  no external library. Two reasons: MV3 extensions can't load remote code
  (no CDN, so something like JSZip would need to be vendored/bundled
  in-repo anyway), and PDFs are already internally compressed, so "store"
  loses nothing over "deflate" while keeping the whole thing dependency-free.
  Verified by generating a zip with nested folder paths and extracting it
  with Windows' native `Expand-Archive` — files and content matched.
- Duplicate filenames within the same zip (e.g. two attachments named
  `Notes.pdf` in different `classFolder`s do NOT collide since the folder
  path is part of the zip entry name, but two in the *same* folder could)
  are disambiguated with a `Notes (2).pdf`-style suffix (`uniqueZipName()`),
  same idea as `conflictAction: "uniquify"` on the individual-download path.
- Files that fail to fetch (interstitial, HTTP error, etc.) are excluded
  from the zip and reported through the existing failures list/manual-open
  fallback, same as a failed individual download.

## v2.3.1 / v2.3.2: zip download crashed silently, then found the real bug

- **v2.3.1** exposed a design mistake: the `.catch()` wrapping the whole
  download run reported a generic failure back to the popup but never
  logged the actual error, so a real crash showed only as
  "N files failed" with zero way to diagnose it. Added `console.error`
  (top-level crash) / `console.warn` (per-file fetch failure) so the next
  one would actually be visible in the service worker's console.
- **v2.3.2**, with that logging in place, the real error surfaced on the
  first retry: `TypeError: URL.createObjectURL is not a function`,
  confirmed via a live test on Edge — its MV3 service worker context
  doesn't expose `URL.createObjectURL`/`revokeObjectURL` the way Chrome's
  does, and that's what `downloadAsZip()` was using to hand the built zip
  Blob to `chrome.downloads.download()`. Replaced with a base64
  `data:application/zip;base64,...` URL instead, which
  `chrome.downloads.download()` accepts directly and doesn't depend on
  that API at all. `String.fromCharCode.apply()` hits the call-stack limit
  on large arrays, so the Blob's bytes are base64-encoded in 32KB chunks;
  verified in Node that a ~2MB buffer round-trips through this chunked
  encode/decode byte-for-byte before shipping it.

## v2.3.3: background-page fetch() was unreliable, moved into the tab

- Even after fixing the `URL.createObjectURL` crash, a live retry on the
  original 523-file Moodle course page showed **every single** `fetch()`
  from the background service worker failing with a generic
  `TypeError: Failed to fetch` — this was fetching cross-origin using the
  `"<all_urls>"` optional host permission from v2.3.0, granted via
  `chrome.permissions.request()` right before sending the download message.
  Rather than keep chasing why that specific combination doesn't work
  (suspected Edge-specific quirk, unconfirmed), replaced the whole approach:
  `background.js` now runs the fetch *inside the scanned tab itself* via
  `chrome.scripting.executeScript()` (`fetchBytesInPage()`, injected;
  result relayed back as a base64 string, decoded with `base64ToBytes()`).
  Since the PDF is always same-origin to the tab it was scanned from, this
  is exactly like the page fetching its own file — no CORS issue, and no
  extra permission prompt, just the `activeTab`/`scripting` access the
  extension already had.
- The tradeoff: this only works for files that are same-origin to the
  scanned tab. That's true for every generic/Moodle item (scanned directly
  off the page), but not for Classroom's Drive/Docs export URLs, which are
  cross-origin to the `classroom.google.com` tab they were scanned from —
  injecting into that tab wouldn't help, since a page's own script hitting
  a different origin hits the same CORS wall. So zip mode is now gated on
  `mode === "generic"` in `popup.js` — Classroom always uses the existing
  per-file download path, unaffected by any of this. `"<all_urls>"` /
  `optional_host_permissions` and the `chrome.permissions.request()` call
  were removed entirely — no longer needed, and one less scary permission
  prompt for users to see.
- If Classroom zip-bundling is wanted later, it'd need its own approach
  (e.g. request permission scoped to just `drive.google.com` /
  `docs.google.com` / `drive.usercontent.google.com` and go back to a
  background-page fetch for *that* case specifically) rather than reusing
  this tab-injection trick.

## v2.3.4: one giant zip doesn't scale, split into size-capped parts

- With the fetch itself finally working (v2.3.3), the *same* 523-file
  Moodle page hit a new wall: `RangeError: Invalid string length` inside
  `downloadAsZip()`. Combining ~500 real PDFs (several hundred MB total)
  into one zip, then that whole zip into one base64 string for the
  `data:` URL, blows past the JS engine's max string length — this was
  never going to scale no matter how the per-file base64 chunking was
  tuned, because the *final* concatenation is what's unbounded, not the
  per-chunk size.
- Fixed by not building one zip at all: `groupEntriesForZipParts()` splits
  the fetched entries into groups capped at `MAX_ZIP_PART_BYTES` (60MB of
  uncompressed file data each — comfortably under the string-length limit
  even after base64 inflates it by ~33%), and `downloadZipPart()` builds
  and downloads each group as its own `.zip`, sequentially. Below the cap
  (the common case), this is unchanged — one file: `BulkPDFDownloader-
  <timestamp>.zip`. Above it: `BulkPDFDownloader-<timestamp>-part1of3.zip`,
  `-part2of3.zip`, etc. Verified the grouping logic in Node against a
  simulated 523-file batch with realistic (1-10MB) file sizes — produced
  22 parts, each landing at or just under the 60MB cap.

## v2.4.0: one real combined zip via an offscreen document

- Splitting into parts (v2.3.4) worked, but wasn't what was actually
  wanted — one real zip containing everything, not a dozen. The size limit
  was never really about the zip itself; it was specifically a limitation
  of turning it into one giant base64 *string* for a `data:` URL. A Blob
  never needs to become a string at all, so the real fix is getting back
  to something Blob-shaped — just not via `URL.createObjectURL()` in the
  service worker, since that's what was missing in the first place
  (v2.3.2).
- Added `offscreen.html` / `offscreen.js`, using the `chrome.offscreen` API
  (declared via the new `"offscreen"` permission) to spin up an invisible
  extension page that — unlike the service worker — has a real DOM and
  therefore does have `URL.createObjectURL`. `background.js` builds the
  zip as before, sends the raw bytes to that page
  (`OFFSCREEN_MAKE_BLOB_URL`), gets back a `blob:` URL, and passes that
  straight to `chrome.downloads.download()` — the offscreen document and
  the service worker are the same extension origin, so a blob URL created
  in one is usable from the other. Revoked shortly after
  (`OFFSCREEN_REVOKE_BLOB_URL`) once the download has had a moment to
  start reading it.
- The v2.3.4 split-into-parts path is kept as a fallback (`downloadEntries
  AsZip()` tries the offscreen route first, falls back to it on any
  failure — e.g. `chrome.offscreen` unsupported in some browser) rather
  than removed, since it's a reasonable safety net and the two don't
  conflict.

## v2.4.1: sending the zip bytes in one message also failed

- v2.4.0's `OFFSCREEN_MAKE_BLOB_URL` sent the entire zip's raw bytes to the
  offscreen document in a single `chrome.runtime.sendMessage()` call.
  Confirmed live on the 523-file batch: that call itself failed outright --
  `Error in invocation of runtime.sendMessage(...): Could not serialize
  message` -- extension messaging has its own hard limit independent of
  the string-length problem v2.4.0 was solving, and a ~60MB+ payload blew
  past it.
- Fixed by streaming the bytes over in small pieces instead of one message:
  `background.js` slices the zip into `ZIP_TRANSFER_CHUNK_BYTES` (4MB)
  pieces, base64-encodes each individually (small enough to never risk the
  v2.3.4 string-length problem), and sends a sequence of
  `OFFSCREEN_ZIP_BEGIN` → `OFFSCREEN_ZIP_CHUNK` (× N) →
  `OFFSCREEN_ZIP_FINISH` messages. `offscreen.js` collects the decoded
  chunks into a plain array and only calls `new Blob(chunks)` at the very
  end -- `Blob`'s constructor accepts an array of parts directly, so
  nothing on either side ever needs to become one giant string, one giant
  typed array, or one giant message. Verified in Node that a `Blob` built
  from several small `Uint8Array` chunks reassembles byte-for-byte
  correctly.

## v2.5.0: zip built incrementally, Moodle sections become folders

- **v2.4.1 still ended up in the split fallback** on the real course
  (`lms.aps.rjt.ac.lk/course/view.php?id=1295`, 466 PDFs, 1GB+): the
  service worker still held every fetched PDF *and* then a second full copy
  as the finished zip's ArrayBuffer before chunking it over. The user got
  ~20 × 60MB `download (N).zip` parts instead of one zip.
- The zip is now built **in the offscreen document, one file at a time**.
  `background.js` fetches a file in the tab (unchanged), streams its base64
  over a dedicated `chrome.runtime.connect` port in 4MB slices, and
  `offscreen.js` appends it to a `ZipWriter` straight away, wrapping that
  file in its own Blob so its bytes can be dropped (and paged to disk by
  the browser). Neither side ever holds the whole archive. A port is used
  instead of `runtime.sendMessage` so the popup isn't sent the chunks too.
- The zip writer moved into `zip.js` (shared by the service worker via
  `importScripts` and the offscreen page via `<script>`), and now writes
  Zip64 records automatically past 4GB / 65535 entries. Verified in Node
  (normal and forced-Zip64 archives with nested folders and multi-chunk
  files) against Python's `zipfile` and Windows' `Expand-Archive`.
- The blob URL is now only revoked once the download actually completes
  (tracked in `storage.session` + a top-level `downloads.onChanged`
  listener), not after a fixed 1s -- a 1GB+ download takes far longer. The
  offscreen document is closed when nothing is pending.
- **Folders from Moodle sections.** That course has ~60 flat sections whose
  names carry the hierarchy in many spellings ("B.Sc in Applied Sciences
  First Year - Semester II Examination - Oct / Nov 2025", "... Fourth Year
  - Semester - I Examination - September/October 2019", "Nove / Dece 2023",
  combined "Semester II ... & Semester I ..." sittings). The scan now reads
  each link's `li.section[data-sectionname]` (confirmed present on every
  section), and `foldersForSection()` in `popup.js` turns it into
  `Year 1/Semester 2/2025 Oct-Nov`. Checked against all 62 live section
  names -- every one parsed as intended. Names that don't look like an exam
  sitting fall back to one folder named after the section.
- The zip is named after the course heading
  (`BulkPDFDownloader/E-Library - Department of Computing.zip`). Individual
  (<10 file) downloads use the same folder layout under `BulkPDFDownloader/`.
- **Section title links were being detected as PDFs.** The live page showed
  523 "PDFs" for 466 real files: each section's title link walks up to the
  whole section, which contains PDF icons, so `hasPdfIcon()` matched. Those
  57 entries downloaded as HTML and showed up as failures. Links inside
  section headers and the course-index drawer are now skipped for icon
  detection -- the scan returns exactly the 466 resources.
- The data: URL fallback (no `chrome.offscreen`) now writes one zip per
  top-level folder (`<course> - Year 1.zip`), split into `(part N)` only if
  a single year passes the 60MB cap. Every entry keeps its full path, so
  extracting all parts together rebuilds the same tree.

## Possible next features

1. **Smarter filenames**: currently uses the link text, falling back to the
   URL's last segment. Could add a "rename pattern" option, e.g.
   `{site}-{n}.pdf`, for when link text is junk like "Download".
2. **Persist last scan per-tab**: cache results in `chrome.storage.session`
   keyed by tab ID so reopening the popup on the same tab doesn't re-scan.
3. **"Only new since last visit" toggle**: store previously-downloaded URLs
   in `chrome.storage.local` and let users skip duplicates across sessions.
4. **Group by domain / folder mirroring**: if scanning a page with PDFs
   from multiple sub-sites, group them in the popup list under collapsible
   headers.
5. **Keyboard shortcuts**: `Ctrl+A` to select all while the popup is
   focused, `Enter` to trigger download.
6. **Dark mode**: match `prefers-color-scheme` for the popup.

## Publishing to the Chrome Web Store

1. **Icons**: already included at 16/48/128px in `icons/` (simple placeholder
   design — swap in your own branding before publishing).
2. **Zip it**: from inside the `pdf-downloader/` folder, zip the *contents*
   (not the folder itself) — the zip's root must contain `manifest.json`
   directly:
   ```
   cd pdf-downloader
   zip -r ../pdf-downloader.zip . -x ".git/*"
   ```
3. **Developer account**: go to the
   [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole),
   pay the one-time $5 registration fee if you haven't already.
4. **New item** → upload the zip.
5. Fill in the store listing: name, short/long description, at least one
   1280x800 (or 640x400) screenshot, and a category (e.g. "Productivity" or
   "Tools").
6. **Privacy practices tab**: you'll be asked to justify each permission.
   - `activeTab` + `scripting`: "used to scan the currently open tab for PDF
     links only when the user opens the extension popup."
   - `downloads`: "used to save the PDF files the user selects to their
     Downloads folder."
   Since this extension collects no personal data and sends nothing to any
   server, you can state "This extension does not collect or transmit user
   data" — you technically don't need a hosted privacy policy for that
   declaration, but the dashboard may still prompt for a policy URL; a short
   one-line policy page works fine.
7. Submit for review. Simple, single-purpose extensions like this typically
   clear review in a few days, faster than ones requesting broad host
   permissions — which is why this build avoids `<all_urls>`.

## Testing checklist before submitting

- [ ] Test on a page with 15+ real PDF links (e.g. a university course page
      or an academic papers index).
- [ ] Test on a page with zero PDFs (empty state shows correctly).
- [ ] Test filter box narrows the list.
- [ ] Test Select All / individual unchecking / partial-selection
      (indeterminate) state.
- [ ] Test on `chrome://` or `file://` pages (should show the "can't be
      scanned" message instead of erroring).
- [ ] Confirm downloaded files land in `Downloads/BulkPDFDownloader/`.

## v2.5.1: renamed to Bulk PDF Downloader

- Renamed from "Bulk PDF Grabber" because Chrome Web Store users search for
  "PDF downloader". Everything was renamed: the manifest name, GitHub repo
  (`bulk-pdf-downloader-extension`; GitHub redirects the old URL), the
  `Downloads/BulkPDFDownloader/` output folder, the `__pdfDownloaderDebug`
  console helper and the internal port name. Older notes above still use the
  old names where they describe past versions.
- Users who already have files in `Downloads/BulkPDFGrabber/` keep them
  there; new downloads go to the new folder.
