// Minimal ZIP writer (store method -- no compression, no dependency).
// Shared by background.js (importScripts) and offscreen.html (<script>).
//
// PDFs are already internally compressed, so "store" loses nothing over
// "deflate" while keeping this dependency-free -- MV3 extensions can't pull
// in a library from a CDN (no remote code allowed).
//
// Built incrementally: each add() wraps that one file's bytes in its own
// Blob straight away, so the caller can drop its copy of the bytes and the
// browser is free to page finished entries out to disk. Nothing here ever
// holds the whole archive as one ArrayBuffer or string -- that's what broke
// every earlier attempt on a 400+ file (1GB+) course page.
//
// Writes Zip64 records automatically once the archive passes 4GB / 65535
// entries, so there's no hard size ceiling on the format side either.
const ZIP_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function zipCrc32(chunks) {
  let crc = 0xffffffff;
  for (const bytes of chunks) {
    for (let i = 0; i < bytes.length; i++) {
      crc = ZIP_CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipDosDateTime(date) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() >> 1) & 0x1f);
  const dateVal =
    (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0xf) << 5) | (date.getDate() & 0x1f);
  return { time, dateVal };
}

function zipUniqueName(used, name) {
  // Windows/7-Zip treat entry names case-insensitively, so dedupe that way.
  const key = (n) => n.toLowerCase();
  if (!used.has(key(name))) {
    used.add(key(name));
    return name;
  }
  const dot = name.lastIndexOf(".");
  const slash = name.lastIndexOf("/");
  const hasExt = dot > slash + 1;
  const base = hasExt ? name.slice(0, dot) : name;
  const ext = hasExt ? name.slice(dot) : "";
  let n = 2;
  let candidate = `${base} (${n})${ext}`;
  while (used.has(key(candidate))) {
    n += 1;
    candidate = `${base} (${n})${ext}`;
  }
  used.add(key(candidate));
  return candidate;
}

const ZIP_U32_MAX = 0xffffffff;
const ZIP_U16_MAX = 0xffff;

class ZipWriter {
  // forceZip64 exists only so the Zip64 code path can be tested without
  // generating a real 4GB archive.
  constructor({ forceZip64 = false } = {}) {
    this.forceZip64 = forceZip64;
    this.blobs = [];
    this.records = [];
    this.offset = 0; // bytes written so far (plain Number: exact up to 2^53)
    this.used = new Set();
    this.encoder = new TextEncoder();
    this.stamp = zipDosDateTime(new Date());
  }

  get count() {
    return this.records.length;
  }

  // chunks: Uint8Array[] holding one file's bytes, in order.
  add(name, chunks) {
    const finalName = zipUniqueName(this.used, name);
    const nameBytes = this.encoder.encode(finalName);
    const size = chunks.reduce((sum, c) => sum + c.length, 0);
    const crc = zipCrc32(chunks);
    const { time, dateVal } = this.stamp;

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 filename flag
    local.setUint16(8, 0, true); // method: store
    local.setUint16(10, time, true);
    local.setUint16(12, dateVal, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);

    this.blobs.push(new Blob([new Uint8Array(local.buffer), nameBytes, ...chunks]));
    this.records.push({ nameBytes, crc, size, offset: this.offset });
    this.offset += 30 + nameBytes.length + size;
    return finalName;
  }

  finish(mimeType = "application/zip") {
    const { time, dateVal } = this.stamp;
    const centralParts = [];
    let centralSize = 0;

    for (const r of this.records) {
      const offset64 = this.forceZip64 || r.offset >= ZIP_U32_MAX;
      const extraLen = offset64 ? 12 : 0;
      const version = offset64 ? 45 : 20;

      const central = new DataView(new ArrayBuffer(46));
      central.setUint32(0, 0x02014b50, true);
      central.setUint16(4, version, true);
      central.setUint16(6, version, true);
      central.setUint16(8, 0x0800, true);
      central.setUint16(10, 0, true);
      central.setUint16(12, time, true);
      central.setUint16(14, dateVal, true);
      central.setUint32(16, r.crc, true);
      central.setUint32(20, r.size, true);
      central.setUint32(24, r.size, true);
      central.setUint16(28, r.nameBytes.length, true);
      central.setUint16(30, extraLen, true);
      central.setUint16(32, 0, true);
      central.setUint16(34, 0, true);
      central.setUint16(36, 0, true);
      central.setUint32(38, 0, true);
      central.setUint32(42, offset64 ? ZIP_U32_MAX : r.offset, true);
      centralParts.push(new Uint8Array(central.buffer), r.nameBytes);

      if (offset64) {
        const extra = new DataView(new ArrayBuffer(12));
        extra.setUint16(0, 0x0001, true); // Zip64 extended information
        extra.setUint16(2, 8, true);
        extra.setBigUint64(4, BigInt(r.offset), true);
        centralParts.push(new Uint8Array(extra.buffer));
      }
      centralSize += 46 + r.nameBytes.length + extraLen;
    }

    const centralStart = this.offset;
    const count = this.records.length;
    const tail = [];
    const needsZip64 =
      this.forceZip64 || count >= ZIP_U16_MAX || centralStart >= ZIP_U32_MAX || centralSize >= ZIP_U32_MAX;

    if (needsZip64) {
      const eocd64 = new DataView(new ArrayBuffer(56));
      eocd64.setUint32(0, 0x06064b50, true);
      eocd64.setBigUint64(4, 44n, true); // size of the rest of this record
      eocd64.setUint16(12, 45, true);
      eocd64.setUint16(14, 45, true);
      eocd64.setUint32(16, 0, true);
      eocd64.setUint32(20, 0, true);
      eocd64.setBigUint64(24, BigInt(count), true);
      eocd64.setBigUint64(32, BigInt(count), true);
      eocd64.setBigUint64(40, BigInt(centralSize), true);
      eocd64.setBigUint64(48, BigInt(centralStart), true);

      const locator = new DataView(new ArrayBuffer(20));
      locator.setUint32(0, 0x07064b50, true);
      locator.setUint32(4, 0, true);
      locator.setBigUint64(8, BigInt(centralStart + centralSize), true);
      locator.setUint32(16, 1, true);

      tail.push(new Uint8Array(eocd64.buffer), new Uint8Array(locator.buffer));
    }

    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true);
    eocd.setUint16(8, needsZip64 ? ZIP_U16_MAX : count, true);
    eocd.setUint16(10, needsZip64 ? ZIP_U16_MAX : count, true);
    eocd.setUint32(12, needsZip64 ? ZIP_U32_MAX : centralSize, true);
    eocd.setUint32(16, needsZip64 ? ZIP_U32_MAX : centralStart, true);
    tail.push(new Uint8Array(eocd.buffer));

    return new Blob([...this.blobs, ...centralParts, ...tail], { type: mimeType });
  }
}
