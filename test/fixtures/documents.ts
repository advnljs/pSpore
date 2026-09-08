import { deflateRawSync } from "node:zlib";

/**
 * Builders for the document formats the extractor reads.
 *
 * The fixtures are assembled here rather than committed as binaries so a reader
 * can see exactly which part of each format a test is exercising, and so a
 * failing test points at a structure rather than at an opaque blob.
 */

// ---------------------------------------------------------------------------
// Office Open XML packages
// ---------------------------------------------------------------------------

/** Writes a real ZIP: a local header per entry, then the central directory. */
export function buildZip(parts: readonly { name: string; content: string }[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const part of parts) {
    const name = Buffer.from(part.name, "utf8");
    const raw = Buffer.from(part.content, "utf8");
    const deflated = deflateRawSync(raw);
    const crc = crc32(raw);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(local, deflated);

    const entry = Buffer.alloc(46 + name.length);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(deflated.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    name.copy(entry, 46);
    central.push(entry);

    offset += local.length + deflated.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// Compound File Binary, the container the pre-2007 formats live in
// ---------------------------------------------------------------------------

const SECTOR = 512;
const MINI_SECTOR = 64;
const MINI_CUTOFF = 4096;
const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;
const FATSECT = 0xfffffffd;

/**
 * Builds a compound document holding `streams`.
 *
 * A stream shorter than the 4096-byte cutoff goes into the mini stream, exactly
 * as the format requires and as every real short `.doc` does; putting all of
 * them in ordinary sectors would leave the mini-stream path untested.
 */
export function buildCompoundFile(streams: readonly { name: string; content: Buffer }[]): Buffer {
  let miniPayload = Buffer.alloc(0);
  const miniFat: number[] = [];
  const placement = new Map<string, number>();
  const regular: { name: string; content: Buffer }[] = [];

  for (const stream of streams) {
    if (stream.content.length < MINI_CUTOFF) {
      const start = miniPayload.length / MINI_SECTOR;
      const padded = pad(stream.content, MINI_SECTOR);
      const count = padded.length / MINI_SECTOR;
      for (let index = 0; index < count; index += 1) {
        miniFat.push(index === count - 1 ? ENDOFCHAIN : start + index + 1);
      }
      miniPayload = Buffer.concat([miniPayload, padded]);
      placement.set(stream.name, start);
    } else {
      regular.push(stream);
    }
  }

  // Sector 0 holds the FAT and sector 1 the directory; everything else follows.
  const layout: Buffer[] = [];
  let next = 2;
  const append = (content: Buffer): number => {
    const padded = pad(content, SECTOR);
    const start = next;
    layout.push(padded);
    next += padded.length / SECTOR;
    return start;
  };
  for (const stream of regular) placement.set(stream.name, append(stream.content));

  const miniFatBytes = Buffer.alloc(miniFat.length * 4);
  miniFat.forEach((value, index) => miniFatBytes.writeUInt32LE(value, index * 4));
  const miniFatStart = miniFat.length > 0 ? append(miniFatBytes) : ENDOFCHAIN;
  const miniFatSectors = miniFat.length > 0 ? Math.ceil(miniFatBytes.length / SECTOR) : 0;
  const miniStreamStart = miniPayload.length > 0 ? append(miniPayload) : ENDOFCHAIN;

  const fat = Buffer.alloc(SECTOR, 0xff);
  fat.writeUInt32LE(FATSECT, 0);
  fat.writeUInt32LE(ENDOFCHAIN, 4);
  let cursor = 2;
  for (const chunk of layout) {
    const count = chunk.length / SECTOR;
    for (let index = 0; index < count; index += 1) {
      fat.writeUInt32LE(index === count - 1 ? ENDOFCHAIN : cursor + index + 1, (cursor + index) * 4);
    }
    cursor += count;
  }
  if (next > SECTOR / 4) throw new Error("fixture needs more than one FAT sector");

  const directory = Buffer.alloc(SECTOR);
  writeDirectoryEntry(directory, 0, "Root Entry", 5, miniStreamStart, miniPayload.length, { child: 1 });
  streams.forEach((stream, index) => {
    // A right-leaning chain keeps every entry reachable from the root's child,
    // which is the path a reader that walks the tree follows.
    writeDirectoryEntry(directory, index + 1, stream.name, 2, placement.get(stream.name) ?? ENDOFCHAIN, stream.content.length, {
      right: index + 1 < streams.length ? index + 2 : FREESECT,
    });
  });

  const header = Buffer.alloc(SECTOR);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(header, 0);
  header.writeUInt16LE(0x003e, 24);
  header.writeUInt16LE(0x0003, 26);
  header.writeUInt16LE(0xfffe, 28);
  header.writeUInt16LE(9, 30);
  header.writeUInt16LE(6, 32);
  header.writeUInt32LE(1, 44);
  header.writeUInt32LE(1, 48);
  header.writeUInt32LE(MINI_CUTOFF, 56);
  header.writeUInt32LE(miniFatStart, 60);
  header.writeUInt32LE(miniFatSectors, 64);
  header.writeUInt32LE(ENDOFCHAIN, 68);
  header.writeUInt32LE(0, 72);
  for (let index = 0; index < 109; index += 1) header.writeUInt32LE(index === 0 ? 0 : FREESECT, 76 + index * 4);

  return Buffer.concat([header, fat, directory, ...layout]);
}

function writeDirectoryEntry(
  directory: Buffer,
  index: number,
  name: string,
  type: number,
  start: number,
  size: number,
  links: { left?: number; right?: number; child?: number } = {},
): void {
  const offset = index * 128;
  const encoded = Buffer.from(`${name}\0`, "utf16le");
  encoded.copy(directory, offset);
  directory.writeUInt16LE(encoded.length, offset + 64);
  directory.writeUInt8(type, offset + 66);
  directory.writeUInt8(1, offset + 67);
  directory.writeUInt32LE(links.left ?? FREESECT, offset + 68);
  directory.writeUInt32LE(links.right ?? FREESECT, offset + 72);
  directory.writeUInt32LE(links.child ?? FREESECT, offset + 76);
  directory.writeUInt32LE(start, offset + 116);
  directory.writeBigUInt64LE(BigInt(size), offset + 120);
}

function pad(content: Buffer, size: number): Buffer {
  const remainder = content.length % size;
  return remainder === 0 ? content : Buffer.concat([content, Buffer.alloc(size - remainder)]);
}

// ---------------------------------------------------------------------------
// The legacy formats themselves
// ---------------------------------------------------------------------------

/** A Word 97 document: a FIB in `WordDocument`, a piece table in `1Table`. */
export function buildLegacyWord(text: string): Buffer {
  const textOffset = 0x0800;
  const encoded = Buffer.from(text, "utf16le");
  const main = Buffer.alloc(textOffset + encoded.length + 64);
  main.writeUInt16LE(0xa5ec, 0x00);
  main.writeUInt16LE(0x00c1, 0x02);
  // Bit 9 says the piece table lives in `1Table` rather than `0Table`.
  main.writeUInt16LE(0x0200, 0x0a);
  main.writeUInt32LE(textOffset, 0x18);
  main.writeUInt32LE(text.length, 0x4c);
  encoded.copy(main, textOffset);

  // Two character positions bracket one piece descriptor, which is what fixes
  // the number of pieces for a given table length.
  const pieceTable = Buffer.alloc(4 + 4 + 8);
  pieceTable.writeUInt32LE(0, 0);
  pieceTable.writeUInt32LE(text.length, 4);
  pieceTable.writeUInt32LE(textOffset, 10);
  const clx = Buffer.concat([Buffer.from([0x02]), lengthPrefix(pieceTable.length), pieceTable]);
  main.writeUInt32LE(0, 0x01a2);
  main.writeUInt32LE(clx.length, 0x01a6);

  return buildCompoundFile([
    { name: "WordDocument", content: main },
    { name: "1Table", content: clx },
  ]);
}

/** A PowerPoint 97 deck: text atoms inside slide containers. */
export function buildLegacyPowerPoint(slides: readonly (readonly string[])[]): Buffer {
  const chunks: Buffer[] = [];
  slides.forEach((lines, index) => {
    // A SlidePersistAtom between decks of text atoms is what separates slides.
    if (index > 0) chunks.push(pptRecord(0x03f3, Buffer.alloc(8), false));
    const body = Buffer.concat(lines.map((line) => pptRecord(0x0fa0, Buffer.from(line, "utf16le"), false)));
    chunks.push(pptRecord(0x03ee, body, true));
  });
  return buildCompoundFile([{ name: "PowerPoint Document", content: Buffer.concat(chunks) }]);
}

function pptRecord(type: number, body: Buffer, container: boolean): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt16LE(container ? 0x000f : 0x0000, 0);
  header.writeUInt16LE(type, 2);
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

/** An Excel 97 workbook: a shared string table plus one sheet of records. */
export function buildLegacyExcel(
  sheetName: string,
  rows: readonly (readonly (string | number)[])[],
): Buffer {
  const shared: string[] = [];
  const indexOf = (value: string): number => {
    const existing = shared.indexOf(value);
    if (existing >= 0) return existing;
    shared.push(value);
    return shared.length - 1;
  };

  const cells: Buffer[] = [];
  rows.forEach((row, rowIndex) => {
    row.forEach((value, columnIndex) => {
      if (typeof value === "number") {
        const body = Buffer.alloc(14);
        body.writeUInt16LE(rowIndex, 0);
        body.writeUInt16LE(columnIndex, 2);
        body.writeDoubleLE(value, 6);
        cells.push(biffRecord(0x0203, body));
      } else {
        const body = Buffer.alloc(10);
        body.writeUInt16LE(rowIndex, 0);
        body.writeUInt16LE(columnIndex, 2);
        body.writeUInt32LE(indexOf(value), 6);
        cells.push(biffRecord(0x00fd, body));
      }
    });
  });

  const strings = Buffer.concat(shared.map((value) => {
    const encoded = Buffer.from(value, "utf16le");
    const head = Buffer.alloc(3);
    head.writeUInt16LE(value.length, 0);
    head.writeUInt8(0x01, 2);
    return Buffer.concat([head, encoded]);
  }));
  const sstHead = Buffer.alloc(8);
  sstHead.writeUInt32LE(shared.length, 0);
  sstHead.writeUInt32LE(shared.length, 4);
  const sst = biffRecord(0x00fc, Buffer.concat([sstHead, strings]));

  const globalBof = biffRecord(0x0809, Buffer.alloc(16));
  const sheetNameBytes = Buffer.from(sheetName, "utf16le");
  const boundsheetBody = Buffer.alloc(8 + sheetNameBytes.length);
  boundsheetBody.writeUInt8(sheetName.length, 6);
  boundsheetBody.writeUInt8(0x01, 7);
  sheetNameBytes.copy(boundsheetBody, 8);
  const globalEof = biffRecord(0x000a, Buffer.alloc(0));

  const sheetBody = Buffer.concat([
    biffRecord(0x0809, Buffer.alloc(16)),
    ...cells,
    biffRecord(0x000a, Buffer.alloc(0)),
  ]);
  // The sheet's own offset is only known once the global section is sized, so
  // the record is written twice: first to measure, then with the real offset.
  const measured = Buffer.concat([globalBof, sst, biffRecord(0x0085, boundsheetBody), globalEof]);
  boundsheetBody.writeUInt32LE(measured.length, 0);
  const workbook = Buffer.concat([
    globalBof,
    sst,
    biffRecord(0x0085, boundsheetBody),
    globalEof,
    sheetBody,
  ]);
  return buildCompoundFile([{ name: "Workbook", content: workbook }]);
}

function biffRecord(id: number, body: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt16LE(id, 0);
  header.writeUInt16LE(body.length, 2);
  return Buffer.concat([header, body]);
}

function lengthPrefix(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value, 0);
  return buffer;
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

/** A one-page PDF drawing `lines` in a standard font, with a real xref table. */
export function buildPdf(lines: readonly string[]): Buffer {
  const content = Buffer.from(
    `BT /F1 18 Tf 72 720 Td ${lines.map((line, index) => (index === 0 ? "" : "0 -24 Td ") + `(${line}) Tj `).join("")}ET`,
    "latin1",
  );
  const objects = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>", "latin1"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "latin1"),
    Buffer.from(
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R"
      + " /Resources << /Font << /F1 5 0 R >> >> >>",
      "latin1",
    ),
    Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`, "latin1"), content, Buffer.from("\nendstream", "latin1")]),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", "latin1"),
  ];

  const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n", "latin1")];
  const offsets: number[] = [];
  let length = chunks[0]?.length ?? 0;
  objects.forEach((object, index) => {
    offsets.push(length);
    const body = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`, "latin1"), object, Buffer.from("\nendobj\n", "latin1")]);
    chunks.push(body);
    length += body.length;
  });

  const xref = length;
  chunks.push(Buffer.from(
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
    + offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")
    + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
    "latin1",
  ));
  return Buffer.concat(chunks);
}
