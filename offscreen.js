// Runs in an offscreen document (chrome.offscreen), a real DOM context the
// MV3 background service worker doesn't have. It builds the combined zip
// and hands back a Blob object URL for chrome.downloads.download --
// URL.createObjectURL is unavailable in some browsers' service worker
// context (confirmed missing in Edge, see DEVELOPMENT.md's v2.3.2 note).
//
// v2.5.0: the zip is built here *incrementally*, one file at a time, over a
// dedicated port from background.js (see DEVELOPMENT.md). Each file's bytes
// arrive as a few small base64 chunks, get appended to the ZipWriter as
// soon as the file is complete, and are then dropped -- so neither this
// page nor the service worker ever holds the whole (1GB+) archive in
// memory at once. A port is used instead of runtime.sendMessage so the
// popup (which also listens to runtime messages) isn't sent hundreds of MB
// of chunks it doesn't care about.

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "bulk-pdf-grabber-zip") return;

  let writer = new ZipWriter();
  let pendingChunks = [];

  port.onMessage.addListener((message) => {
    const reply = (payload) => port.postMessage({ replyTo: message.id, ...payload });
    try {
      if (message.type === "PING") {
        reply({ ok: true });
      } else if (message.type === "FILE_CHUNK") {
        pendingChunks.push(base64ToBytes(message.base64));
        reply({ ok: true });
      } else if (message.type === "FILE_END") {
        const name = writer.add(message.name, pendingChunks);
        pendingChunks = [];
        reply({ ok: true, name });
      } else if (message.type === "FINISH") {
        const blob = writer.finish();
        writer = new ZipWriter();
        reply({ ok: true, url: URL.createObjectURL(blob), size: blob.size });
      }
    } catch (e) {
      reply({ ok: false, error: String((e && e.message) || e) });
    }
  });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "OFFSCREEN_REVOKE_BLOB_URL") {
    URL.revokeObjectURL(message.url);
  }
  return false;
});
