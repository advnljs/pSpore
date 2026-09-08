import { OleDocument } from "./ole.js";

/**
 * Text out of the pre-2007 binary Office formats.
 *
 * Each of the three keeps its text somewhere different inside the compound
 * document, and none of them stores it as a contiguous run, so the shape of
 * every function here follows the format rather than a shared abstraction.
 * The goal throughout is the words on the page: layout, styling and revision
 * history are deliberately dropped.
 */

export type LegacyKind = "doc" | "xls" | "ppt";

export interface LegacyDocument {
  kind: LegacyKind;
  text: string;
  sections: readonly { name: string; text: string }[];
}

/** Which legacy format a compound document holds, decided by its streams. */
export function detectLegacyKind(document: OleDocument): LegacyKind | undefined {
  if (document.has("WordDocument")) return "doc";
  if (document.has("Workbook") || document.has("Book")) return "xls";
  if (document.has("PowerPoint Document")) return "ppt";
  return undefined;
}

export function extractLegacy(document: OleDocument, kind: LegacyKind): LegacyDocument {
  if (kind === "doc") return { kind, text: extractWord(document), sections: [] };
  if (kind === "xls") return extractWorkbook(document);
  return extractPresentation(document);
}

// ---------------------------------------------------------------------------
// Word 97-2003
// ---------------------------------------------------------------------------

/** Offsets into the File Information Block, which is fixed for Word 97 onwards. */
const FIB_FLAGS = 0x000a;
const FIB_CCP_TEXT = 0x004c;
const FIB_FC_CLX = 0x01a2;
const FIB_LCB_CLX = 0x01a6;

/** Bit 9 of the FIB flags picks which of the two table streams is in use. */
const FIB_WHICH_TABLE_STREAM = 0x0200;

/**
 * Word does not store its text in reading order. The document is a sequence of
 * pieces, and the piece table in the table stream says where each one lives and
 * whether it was written as 8-bit or 16-bit characters. Reading the text stream
 * directly returns the pieces in whatever order editing left them.
 */
function extractWord(document: OleDocument): string {
  const main = document.read("WordDocument");
  if (!main || main.length < FIB_LCB_CLX + 4) throw new Error("Word document has no readable FIB");

  const useOneTable = (main.readUInt16LE(FIB_FLAGS) & FIB_WHICH_TABLE_STREAM) !== 0;
  const table = document.read(useOneTable ? "1Table" : "0Table") ?? document.read("1Table") ?? document.read("0Table");
  const characterCount = main.readUInt32LE(FIB_CCP_TEXT);
  if (!table) {
    // A document written by a very old release keeps its text contiguously from
    // the start of the text stream, with no piece table to consult.
    return collapse(decodeWordRun(main.subarray(0x0800, 0x0800 + characterCount), true));
  }

  const clxOffset = main.readUInt32LE(FIB_FC_CLX);
  const clxLength = main.readUInt32LE(FIB_LCB_CLX);
  const pieces = readPieceTable(table.subarray(clxOffset, clxOffset + clxLength), characterCount);
  let text = "";
  for (const piece of pieces) {
    text += decodeWordRun(main.subarray(piece.offset, piece.offset + piece.byteLength), piece.compressed);
  }
  return collapse(text);
}

interface WordPiece {
  offset: number;
  byteLength: number;
  compressed: boolean;
}

/**
 * Walks the CLX to its piece table. The CLX is a list of property runs, each
 * introduced by 0x01, followed by the piece table introduced by 0x02, so the
 * property runs have to be stepped over rather than searched past.
 */
function readPieceTable(clx: Buffer, characterCount: number): WordPiece[] {
  let cursor = 0;
  while (cursor < clx.length && clx[cursor] === 0x01) {
    if (cursor + 3 > clx.length) return [];
    cursor += 3 + clx.readUInt16LE(cursor + 1);
  }
  if (cursor >= clx.length || clx[cursor] !== 0x02 || cursor + 5 > clx.length) return [];
  const length = clx.readUInt32LE(cursor + 1);
  const table = clx.subarray(cursor + 5, cursor + 5 + length);

  // The table is (n + 1) character positions followed by n 8-byte descriptors,
  // which is what fixes n for a given length.
  const count = Math.floor((table.length - 4) / 12);
  const pieces: WordPiece[] = [];
  for (let index = 0; index < count; index += 1) {
    const start = table.readUInt32LE(index * 4);
    const end = table.readUInt32LE((index + 1) * 4);
    if (end <= start || start > characterCount) continue;
    const descriptor = (count + 1) * 4 + index * 8;
    if (descriptor + 8 > table.length) break;
    const fc = table.readUInt32LE(descriptor + 2);
    // Bit 30 marks a piece written one byte per character; clearing it and
    // halving the remainder gives the byte offset of a compressed piece.
    const compressed = (fc & 0x40000000) !== 0;
    const offset = compressed ? (fc & 0x3fffffff) >>> 1 : fc & 0x3fffffff;
    const characters = end - start;
    pieces.push({ offset, byteLength: compressed ? characters : characters * 2, compressed });
  }
  return pieces;
}

/**
 * Word's control characters, mapped to what they mean to a reader. Everything
 * below a space that is not listed marks a field or an anchor and is dropped.
 */
function decodeWordRun(run: Buffer, compressed: boolean): string {
  const decoded = compressed
    // A compressed piece is Windows-1252 with a handful of remapped positions;
    // for the CJK documents this exists to read, those pieces are pure ASCII.
    ? new TextDecoder("windows-1252").decode(run)
    : new TextDecoder("utf-16le").decode(run);
  let text = "";
  for (const character of decoded) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0x0d || code === 0x07) text += "\n";
    else if (code === 0x0b) text += "\n";
    else if (code === 0x09) text += "\t";
    else if (code === 0x0c) text += "\n\n";
    else if (code === 0x1e) text += "-";
    else if (code === 0x1f) text += "";
    else if (code >= 0x20 || code === 0x0a) text += character;
  }
  return text;
}

// ---------------------------------------------------------------------------
// Excel 97-2003
// ---------------------------------------------------------------------------

const RECORD_FORMULA = 0x0006;
const RECORD_EOF = 0x000a;
const RECORD_CONTINUE = 0x003c;
const RECORD_BOUNDSHEET = 0x0085;
const RECORD_SST = 0x00fc;
const RECORD_LABELSST = 0x00fd;
const RECORD_MULRK = 0x00bd;
const RECORD_BOF = 0x0809;
const RECORD_RK = 0x027e;
const RECORD_LABEL = 0x0204;
const RECORD_NUMBER = 0x0203;
const RECORD_STRING = 0x0207;
const RECORD_BOOLERR = 0x0205;

interface BiffRecord {
  id: number;
  body: Buffer;
  /** Bodies of the CONTINUE records that followed, which split long values. */
  continuations: Buffer[];
}

/**
 * Excel writes one flat record stream for the whole workbook: a global section
 * holding the shared string table and the sheet directory, then one section per
 * sheet. Cells reference strings by index, so the table has to be read first.
 */
function extractWorkbook(document: OleDocument): LegacyDocument {
  const stream = document.read("Workbook") ?? document.read("Book");
  if (!stream) throw new Error("Workbook stream is missing");
  const records = readBiffRecords(stream);

  const sharedStrings = readSharedStringTable(records);
  const sheets = records
    .filter((record) => record.id === RECORD_BOUNDSHEET && record.body.length >= 8)
    .map((record) => ({
      offset: record.body.readUInt32LE(0),
      name: readShortBiffString(record.body, 6),
    }));

  const sections = sheets.map((sheet, index) => ({
    name: sheet.name || `工作表 ${index + 1}`,
    text: readSheetCells(stream, sheet.offset, sharedStrings),
  }));
  return { kind: "xls", sections, text: joinSections(sections) };
}

function readBiffRecords(stream: Buffer, from = 0, stopAtEof = false): BiffRecord[] {
  const records: BiffRecord[] = [];
  let cursor = from;
  while (cursor + 4 <= stream.length) {
    const id = stream.readUInt16LE(cursor);
    const length = stream.readUInt16LE(cursor + 2);
    if (cursor + 4 + length > stream.length) break;
    const body = stream.subarray(cursor + 4, cursor + 4 + length);
    cursor += 4 + length;
    if (id === RECORD_CONTINUE) {
      // A CONTINUE belongs to whatever record came before it; on its own it has
      // no meaning, and dropping it would truncate long strings.
      records.at(-1)?.continuations.push(body);
      continue;
    }
    records.push({ id, body, continuations: [] });
    if (stopAtEof && id === RECORD_EOF) break;
  }
  return records;
}

/**
 * The shared string table can outgrow one record, and a string may straddle the
 * boundary. Each continuation restarts with its own flags byte saying whether
 * the remainder is 8- or 16-bit, so the pieces cannot simply be concatenated.
 */
function readSharedStringTable(records: readonly BiffRecord[]): string[] {
  const record = records.find((candidate) => candidate.id === RECORD_SST);
  if (!record || record.body.length < 8) return [];
  const chunks = [record.body, ...record.continuations];
  const uniqueCount = record.body.readUInt32LE(4);

  const strings: string[] = [];
  let chunk = 0;
  let cursor = 8;
  const advance = (): boolean => {
    while (chunk < chunks.length && cursor >= (chunks[chunk]?.length ?? 0)) {
      chunk += 1;
      cursor = 0;
    }
    return chunk < chunks.length;
  };

  for (let index = 0; index < uniqueCount; index += 1) {
    if (!advance()) break;
    const current = chunks[chunk] as Buffer;
    if (cursor + 3 > current.length) break;
    const characters = current.readUInt16LE(cursor);
    let flags = current.readUInt8(cursor + 2);
    cursor += 3;
    // Rich-text runs and East Asian phonetic guides are sized here and skipped
    // after the characters; both are formatting, not content.
    let runCount = 0;
    let phoneticBytes = 0;
    if ((flags & 0x08) !== 0) {
      runCount = current.readUInt16LE(cursor);
      cursor += 2;
    }
    if ((flags & 0x04) !== 0) {
      phoneticBytes = current.readUInt32LE(cursor);
      cursor += 4;
    }

    let text = "";
    let remaining = characters;
    while (remaining > 0) {
      if (!advance()) break;
      const buffer = chunks[chunk] as Buffer;
      const wide = (flags & 0x01) !== 0;
      const available = buffer.length - cursor;
      const take = Math.min(remaining, wide ? Math.floor(available / 2) : available);
      if (take <= 0) {
        // The value continues in the next record, which restates its own width.
        chunk += 1;
        cursor = 0;
        if (chunk >= chunks.length) break;
        flags = (chunks[chunk] as Buffer).readUInt8(0);
        cursor = 1;
        continue;
      }
      const bytes = wide ? take * 2 : take;
      text += wide
        ? new TextDecoder("utf-16le").decode(buffer.subarray(cursor, cursor + bytes))
        : new TextDecoder("windows-1252").decode(buffer.subarray(cursor, cursor + bytes));
      cursor += bytes;
      remaining -= take;
    }
    strings.push(text);
    cursor += runCount * 4 + phoneticBytes;
  }
  return strings;
}

function readSheetCells(stream: Buffer, offset: number, sharedStrings: readonly string[]): string {
  if (offset <= 0 || offset >= stream.length || stream.readUInt16LE(offset) !== RECORD_BOF) return "";
  const rows = new Map<number, Map<number, string>>();
  const put = (row: number, column: number, value: string): void => {
    if (value === "") return;
    const line = rows.get(row) ?? new Map<number, string>();
    line.set(column, value);
    rows.set(row, line);
  };

  const records = readBiffRecords(stream, offset, true);
  for (const [index, record] of records.entries()) {
    const body = record.body;
    if (body.length < 4) continue;
    const row = body.readUInt16LE(0);
    const column = body.readUInt16LE(2);
    switch (record.id) {
      case RECORD_LABELSST:
        if (body.length >= 10) put(row, column, sharedStrings[body.readUInt32LE(6)] ?? "");
        break;
      case RECORD_LABEL:
        put(row, column, readShortBiffString(body, 6));
        break;
      case RECORD_NUMBER:
        if (body.length >= 14) put(row, column, formatNumber(body.readDoubleLE(6)));
        break;
      case RECORD_RK:
        if (body.length >= 10) put(row, column, formatNumber(decodeRk(body.readUInt32LE(6))));
        break;
      case RECORD_MULRK:
        // One record carrying a run of numbers across consecutive columns.
        for (let cell = 0; cell + 6 <= body.length - 2; cell += 6) {
          put(row, column + cell / 6, formatNumber(decodeRk(body.readUInt32LE(4 + cell + 2))));
        }
        break;
      case RECORD_BOOLERR:
        if (body.length >= 8) put(row, column, body.readUInt8(7) === 0 ? (body.readUInt8(6) ? "TRUE" : "FALSE") : "#ERR");
        break;
      case RECORD_FORMULA: {
        // A formula that evaluated to text is followed by the text itself; one
        // that evaluated to a number carries the result in its own body.
        const next = records[index + 1];
        if (next?.id === RECORD_STRING) put(row, column, readBiffString(next.body));
        else if (body.length >= 14 && body.readUInt16LE(12) !== 0xffff) put(row, column, formatNumber(body.readDoubleLE(6)));
        break;
      }
      default:
        break;
    }
  }

  return [...rows.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, line]) => [...line.entries()].sort(([left], [right]) => left - right).map(([, value]) => value).join("\t"))
    .join("\n");
}

/** A BIFF string whose character count is one byte, as used for sheet names. */
function readShortBiffString(body: Buffer, offset: number): string {
  if (offset >= body.length) return "";
  const characters = body.readUInt8(offset);
  const wide = offset + 1 < body.length && (body.readUInt8(offset + 1) & 0x01) !== 0;
  const start = offset + 2;
  return wide
    ? new TextDecoder("utf-16le").decode(body.subarray(start, start + characters * 2))
    : new TextDecoder("windows-1252").decode(body.subarray(start, start + characters));
}

/** A BIFF string whose character count is two bytes, as used for cell values. */
function readBiffString(body: Buffer): string {
  if (body.length < 3) return "";
  const characters = body.readUInt16LE(0);
  const wide = (body.readUInt8(2) & 0x01) !== 0;
  return wide
    ? new TextDecoder("utf-16le").decode(body.subarray(3, 3 + characters * 2))
    : new TextDecoder("windows-1252").decode(body.subarray(3, 3 + characters));
}

/**
 * RK packs a number into 32 bits: the low two bits say whether the value was
 * stored as a truncated double or a 30-bit integer, and whether it was scaled.
 */
function decodeRk(value: number): number {
  const isInteger = (value & 0x02) !== 0;
  let number: number;
  if (isInteger) {
    // Arithmetic shift: the 30-bit payload is signed.
    number = value >> 2;
  } else {
    const buffer = Buffer.alloc(8);
    buffer.writeUInt32LE(value & 0xfffffffc, 4);
    number = buffer.readDoubleLE(0);
  }
  return (value & 0x01) !== 0 ? number / 100 : number;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "";
  // Excel stores everything as a double; integers should not read as "3.0", and
  // the rest should not carry the noise of binary rounding.
  return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(15)));
}

// ---------------------------------------------------------------------------
// PowerPoint 97-2003
// ---------------------------------------------------------------------------

const ATOM_TEXT_CHARS = 0x0fa0;
const ATOM_TEXT_BYTES = 0x0fa8;
const ATOM_SLIDE_PERSIST = 0x03f3;

/**
 * PowerPoint stores its text as atoms scattered through a record tree. Walking
 * the tree in order recovers the text in slide order without having to model
 * the drawing hierarchy the atoms hang off.
 */
function extractPresentation(document: OleDocument): LegacyDocument {
  const stream = document.read("PowerPoint Document");
  if (!stream) throw new Error("PowerPoint Document stream is missing");

  const slides: string[][] = [];
  let current: string[] = [];
  walkPptRecords(stream, 0, stream.length, (type, body) => {
    if (type === ATOM_SLIDE_PERSIST && current.length > 0) {
      slides.push(current);
      current = [];
      return;
    }
    const text = type === ATOM_TEXT_CHARS
      ? new TextDecoder("utf-16le").decode(body)
      : type === ATOM_TEXT_BYTES
        ? new TextDecoder("windows-1252").decode(body)
        : undefined;
    // Vertical tab is a soft line break and carriage return ends a paragraph.
    if (text !== undefined && text.trim() !== "") current.push(text.replace(/[\v\r]/g, "\n").trim());
  });
  if (current.length > 0) slides.push(current);

  const sections = slides.map((lines, index) => ({
    name: `幻灯片 ${index + 1}`,
    text: lines.join("\n"),
  }));
  return { kind: "ppt", sections, text: joinSections(sections) };
}

/**
 * Records nest: the low nibble of the first field is 0xF on a container, whose
 * body is more records rather than data.
 */
function walkPptRecords(
  stream: Buffer,
  from: number,
  to: number,
  visit: (type: number, body: Buffer) => void,
  depth = 0,
): void {
  if (depth > 32) return;
  let cursor = from;
  while (cursor + 8 <= to) {
    const version = stream.readUInt16LE(cursor) & 0x000f;
    const type = stream.readUInt16LE(cursor + 2);
    const length = stream.readUInt32LE(cursor + 4);
    const start = cursor + 8;
    const end = start + length;
    if (length < 0 || end > to) break;
    if (version === 0x0f) walkPptRecords(stream, start, end, visit, depth + 1);
    else visit(type, stream.subarray(start, end));
    cursor = end;
  }
}

function joinSections(sections: readonly { name: string; text: string }[]): string {
  return sections
    .filter((section) => section.text.trim() !== "")
    .map((section) => `## ${section.name}\n${section.text}`)
    .join("\n\n");
}

function collapse(value: string): string {
  return value.replace(/\n{3,}/g, "\n\n").trim();
}
