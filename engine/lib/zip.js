'use strict';
/**
 * zip.js - just enough of the zip format to read the text out of a Word
 * document (.docx), which is a zip of XML files. Node's zlib does the
 * decompression; this finds the entry and hands it over.
 */

const zlib = require('zlib');

/**
 * Every entry in a zip: [{ name, size, read() }], read() giving its bytes.
 * Throws on anything it cannot read, so a damaged download is never half-used.
 */
function entries(buf, { maxTotal = 200 * 1024 * 1024 } = {}) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('the zip is damaged');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    total += size;
    if (total > maxTotal) throw new Error('the zip is too large');
    if (method !== 0 && method !== 8) throw new Error(`unsupported compression in ${name}`);
    out.push({
      name, size,
      read() {
        if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`the zip is damaged at ${name}`);
        const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
        const data = buf.subarray(start, start + compSize);
        const bytes = method === 0 ? Buffer.from(data) : zlib.inflateRawSync(data, { maxOutputLength: Math.max(size, 1) + 1024 });
        if (bytes.length !== size) throw new Error(`the zip is damaged at ${name}`);
        return bytes;
      },
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** The bytes of one named entry, or null. Reads the central directory, so data descriptors do not matter. */
function readEntry(buf, wanted) {
  // End of central directory: signature 0x06054b50, within the last 65557 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (name === wanted) {
      if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) return null;
      const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
      const data = buf.subarray(start, start + compSize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return zlib.inflateRawSync(data, { maxOutputLength: 50 * 1024 * 1024 });
      return null;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

function decodeXml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&amp;/g, '&');
}

/** The plain text of a .docx: one line per paragraph, tabs between table cells. */
function docxText(buf) {
  const xml = readEntry(buf, 'word/document.xml');
  if (!xml) return null;
  return decodeXml(xml.toString('utf8')
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<\/w:tc>/g, '\t')
    .replace(/<w:br[^>]*\/>|<\/w:p>|<\/w:tr>/g, '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

module.exports = { entries, readEntry, docxText };
