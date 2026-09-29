'use strict';
/**
 * Minimal streaming .xlsx sheet reader — no dependencies.
 *
 * Exists because the NRI workbooks are far too big for SheetJS: the US 2026
 * file's invoice sheet inflates to ~112 MB of XML (65k rows x 29 cols) and the
 * CA one to ~50 MB. `XLSX.readFile` inflates every sheet into memory at once.
 * This reads ONE entry and yields rows as it inflates, at flat memory.
 *
 * Only the subset of SpreadsheetML the NRI files actually use is handled:
 * shared strings, inline strings, numbers, booleans, cached formula values and
 * error cells. Styles/number formats are ignored — dates come back as Excel
 * serial numbers (see excelSerialToISO).
 */

const fs = require('fs');
const zlib = require('zlib');
const { Readable } = require('stream');

/* ------------------------------------------------------------------ ZIP ---- */

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;

function readCentralDirectory(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file (no end-of-central-directory record)');

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = new Map();

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== CD_SIG) break;
    const method = buf.readUInt16LE(off + 10);
    const compressedSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOffset = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    entries.set(name, { method, compressedSize, localOffset });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Raw (still-compressed) bytes of one zip entry, plus its method. */
function locateEntry(buf, entries, name) {
  const e = entries.get(name);
  if (!e) throw new Error(`entry not found in workbook: ${name}`);
  // Local header: 30 bytes fixed + name + extra. Its lengths are authoritative.
  const nameLen = buf.readUInt16LE(e.localOffset + 26);
  const extraLen = buf.readUInt16LE(e.localOffset + 28);
  const start = e.localOffset + 30 + nameLen + extraLen;
  return { method: e.method, data: buf.subarray(start, start + e.compressedSize) };
}

/** A Readable of the entry's decompressed bytes. */
function entryStream(buf, entries, name) {
  const { method, data } = locateEntry(buf, entries, name);
  const raw = Readable.from([data]);
  if (method === 0) return raw;                  // stored
  if (method === 8) return raw.pipe(zlib.createInflateRaw());
  throw new Error(`unsupported zip compression method ${method} for ${name}`);
}

/* ------------------------------------------------------------------ XML ---- */

const ENTITIES = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };

function decodeXml(s) {
  if (s.indexOf('&') === -1) return s;
  return s.replace(/&(?:#x([0-9a-fA-F]+)|#(\d+)|(lt|gt|quot|apos|amp));/g,
    (m, hex, dec, named) => hex ? String.fromCodePoint(parseInt(hex, 16))
      : dec ? String.fromCodePoint(Number(dec))
        : ENTITIES[named]);
}

/** "BC12" -> 54 (0-based column index). */
function columnIndex(ref) {
  let n = 0;
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

/** Excel serial date -> "YYYY-MM-DD" (1900 system, accounting for the 1900 leap bug). */
function excelSerialToISO(serial) {
  if (typeof serial !== 'number' || !isFinite(serial)) return null;
  const ms = Date.UTC(1899, 11, 30) + Math.round(serial * 86400) * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

/* --------------------------------------------------------------- reading --- */

function open(path) {
  return openBuffer(fs.readFileSync(path), path);
}

/** Same as `open` but for an in-memory upload (multer gives us `req.file.buffer`). */
function openBuffer(buf, label) {
  return { buf, entries: readCentralDirectory(buf), path: label || '(buffer)' };
}

async function readAll(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

/** Sheet name -> zip entry path, via workbook.xml + its rels. */
async function sheetIndex(wb) {
  const book = await readAll(entryStream(wb.buf, wb.entries, 'xl/workbook.xml'));
  const rels = await readAll(entryStream(wb.buf, wb.entries, 'xl/_rels/workbook.xml.rels'));

  const target = new Map();
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /Id="([^"]+)"/.exec(m[0]);
    const tgt = /Target="([^"]+)"/.exec(m[0]);
    const type = /Type="([^"]+)"/.exec(m[0]);
    if (id && tgt && type && /\/worksheet$/.test(type[1])) {
      target.set(id[1], 'xl/' + tgt[1].replace(/^\.?\//, ''));
    }
  }

  const out = new Map();
  for (const m of book.matchAll(/<sheet\b[^>]*\/?>/g)) {
    const name = /name="([^"]+)"/.exec(m[0]);
    const rid = /r:id="([^"]+)"/.exec(m[0]);
    if (name && rid && target.has(rid[1])) {
      out.set(decodeXml(name[1]), { entry: target.get(rid[1]), hidden: /state="(hidden|veryHidden)"/.test(m[0]) });
    }
  }
  return out;
}

async function sharedStrings(wb) {
  if (!wb.entries.has('xl/sharedStrings.xml')) return [];
  const xml = await readAll(entryStream(wb.buf, wb.entries, 'xl/sharedStrings.xml'));
  const out = [];
  for (const si of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    let text = '';
    for (const t of si[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) text += t[1];
    out.push(decodeXml(text));
  }
  return out;
}

function parseRowBlock(block, sst) {
  const cells = [];
  for (const c of block.matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const attrs = c[1];
    const body = c[2] || '';
    const ref = /r="([A-Z]+\d+)"/.exec(attrs);
    if (!ref) continue;
    const type = (/t="([^"]+)"/.exec(attrs) || [, 'n'])[1];
    let value = null;

    if (type === 'inlineStr') {
      const t = /<t[^>]*>([\s\S]*?)<\/t>/.exec(body);
      value = t ? decodeXml(t[1]) : '';
    } else {
      const v = /<v>([\s\S]*?)<\/v>/.exec(body);
      if (v) {
        if (type === 's') value = sst[Number(v[1])];
        else if (type === 'str') value = decodeXml(v[1]);
        else if (type === 'b') value = v[1] === '1';
        else if (type === 'e') value = { error: decodeXml(v[1]) };
        else value = Number(v[1]);
      }
    }
    cells[columnIndex(ref[1])] = value;
  }
  return cells;
}

/**
 * Stream one sheet's rows. `onRow(rowNumber, cells)`; return false to stop.
 * `cells` is a sparse array indexed by 0-based column.
 */
async function eachRow(wb, sheetNameOrEntry, sst, onRow) {
  const entry = sheetNameOrEntry.startsWith('xl/')
    ? sheetNameOrEntry
    : (await sheetIndex(wb)).get(sheetNameOrEntry)?.entry;
  if (!entry) throw new Error(`sheet not found: ${sheetNameOrEntry}`);

  const stream = entryStream(wb.buf, wb.entries, entry);
  stream.setEncoding('utf8');

  let tail = '';
  for await (const chunk of stream) {
    tail += chunk;
    let end;
    while ((end = tail.indexOf('</row>')) !== -1) {
      const start = tail.indexOf('<row');
      if (start === -1 || start > end) { tail = tail.slice(end + 6); continue; }
      const block = tail.slice(start, end + 6);
      tail = tail.slice(end + 6);
      const rn = /<row[^>]*\sr="(\d+)"/.exec(block);
      if (onRow(rn ? Number(rn[1]) : null, parseRowBlock(block, sst)) === false) {
        stream.destroy();
        return;
      }
    }
    // Nothing useful can precede an unclosed <row>; keep only the open fragment.
    if (tail.length > 4 << 20) {
      const open = tail.lastIndexOf('<row');
      tail = open === -1 ? '' : tail.slice(open);
    }
  }
}

/** Read a whole sheet as objects keyed by its header row. */
async function readSheetObjects(wb, sheetName, sst) {
  let header = null;
  const rows = [];
  await eachRow(wb, sheetName, sst, (n, cells) => {
    if (!header) {
      header = cells.map(c => (c && c.error ? '' : c === null || c === undefined ? '' : String(c)));
      return true;
    }
    const o = {};
    header.forEach((h, i) => { if (h) o[h] = cells[i]; });
    rows.push(o);
  });
  return rows;
}

module.exports = {
  open, openBuffer, sheetIndex, sharedStrings, eachRow, readSheetObjects,
  columnIndex, decodeXml, excelSerialToISO,
};
