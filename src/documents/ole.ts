/**
 * The container every pre-2007 Office file is written in.
 *
 * A `.doc`, `.xls` or `.ppt` is a Compound File Binary document: a FAT-style
 * filesystem inside one file, whose named streams hold the actual format. The
 * reader is here so the three legacy parsers share one implementation of the
 * container and only differ in how they read their own stream.
 */

const SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

/** Sector chain terminators; anything below them is a real sector number. */
const MAX_REGULAR_SECTOR = 0xfffffffa;
const FREE_SECTOR = 0xffffffff;
const END_OF_CHAIN = 0xfffffffe;

const DIRECTORY_ENTRY_BYTES = 128;
const STREAM_TYPE = 2;

/** DIFAT entries stored in the header before the chain of DIFAT sectors starts. */
const HEADER_DIFAT_ENTRIES = 109;

/**
 * Ceiling on how many sectors one chain may visit. A crafted file can point a
 * chain at itself and read forever, and these documents are untrusted.
 */
const MAX_CHAIN_SECTORS = 1 << 22;

export class OleDocument {
  readonly #buffer: Buffer;
  readonly #sectorSize: number;
  readonly #miniSectorSize: number;
  readonly #miniStreamCutoff: number;
  readonly #fat: number[];
  readonly #miniFat: number[];
  readonly #streams: ReadonlyMap<string, { start: number; size: number }>;
  readonly #miniStream: Buffer;

  private constructor(buffer: Buffer) {
    this.#buffer = buffer;
    this.#sectorSize = 1 << buffer.readUInt16LE(30);
    this.#miniSectorSize = 1 << buffer.readUInt16LE(32);
    this.#miniStreamCutoff = buffer.readUInt32LE(56);
    if (this.#sectorSize < 128 || this.#sectorSize > 1 << 20) {
      throw new Error("Compound document declares an unusable sector size");
    }
    this.#fat = this.#readFat();
    this.#miniFat = this.#readChainValues(buffer.readUInt32LE(60), buffer.readUInt32LE(64));
    const directory = this.#readDirectory();
    this.#miniStream = directory.miniStream;
    this.#streams = directory.streams;
  }

  static open(buffer: Buffer): OleDocument {
    if (!looksLikeOle(buffer)) throw new Error("Not a compound document");
    return new OleDocument(buffer);
  }

  /** Stream names present in the document, for diagnostics and format sniffing. */
  names(): string[] {
    return [...this.#streams.keys()];
  }

  has(name: string): boolean {
    return this.#streams.has(name);
  }

  /** Reads a whole named stream, or undefined when the document has no such stream. */
  read(name: string): Buffer | undefined {
    const entry = this.#streams.get(name);
    if (!entry) return undefined;
    // Short streams live packed inside the mini stream rather than in sectors of
    // their own, which is why the cutoff has to be consulted before reading.
    return entry.size < this.#miniStreamCutoff
      ? this.#readMini(entry.start, entry.size)
      : this.#readSectors(entry.start, entry.size);
  }

  #readFat(): number[] {
    const count = this.#buffer.readUInt32LE(44);
    const sectors: number[] = [];
    for (let index = 0; index < Math.min(count, HEADER_DIFAT_ENTRIES); index += 1) {
      const sector = this.#buffer.readUInt32LE(76 + index * 4);
      if (sector <= MAX_REGULAR_SECTOR) sectors.push(sector);
    }
    // Documents with more than 109 FAT sectors continue the list in a chain of
    // DIFAT sectors, each ending with a pointer to the next.
    let difat = this.#buffer.readUInt32LE(68);
    const difatCount = this.#buffer.readUInt32LE(72);
    const perSector = this.#sectorSize / 4 - 1;
    for (let visited = 0; difat <= MAX_REGULAR_SECTOR && visited < difatCount + 1; visited += 1) {
      const offset = this.#sectorOffset(difat);
      for (let index = 0; index < perSector; index += 1) {
        const sector = this.#buffer.readUInt32LE(offset + index * 4);
        if (sector <= MAX_REGULAR_SECTOR) sectors.push(sector);
      }
      difat = this.#buffer.readUInt32LE(offset + perSector * 4);
    }

    const fat: number[] = [];
    for (const sector of sectors) {
      const offset = this.#sectorOffset(sector);
      for (let index = 0; index < this.#sectorSize / 4; index += 1) {
        fat.push(this.#buffer.readUInt32LE(offset + index * 4));
      }
    }
    return fat;
  }

  /** Follows a chain and returns every 32-bit value the visited sectors hold. */
  #readChainValues(start: number, expectedSectors: number): number[] {
    const values: number[] = [];
    let sector = start;
    for (let visited = 0; sector <= MAX_REGULAR_SECTOR && visited <= expectedSectors; visited += 1) {
      const offset = this.#sectorOffset(sector);
      for (let index = 0; index < this.#sectorSize / 4; index += 1) {
        values.push(this.#buffer.readUInt32LE(offset + index * 4));
      }
      sector = this.#fat[sector] ?? END_OF_CHAIN;
    }
    return values;
  }

  #readDirectory(): { streams: Map<string, { start: number; size: number }>; miniStream: Buffer } {
    const directory = this.#readSectors(this.#buffer.readUInt32LE(48), Number.POSITIVE_INFINITY);
    const streams = new Map<string, { start: number; size: number }>();
    let miniStreamStart = END_OF_CHAIN;
    let miniStreamSize = 0;
    for (let offset = 0; offset + DIRECTORY_ENTRY_BYTES <= directory.length; offset += DIRECTORY_ENTRY_BYTES) {
      const nameBytes = directory.readUInt16LE(offset + 64);
      if (nameBytes < 2 || nameBytes > 64) continue;
      // The stored length counts the terminating NUL, and names are UTF-16LE.
      const name = directory.subarray(offset + 0, offset + nameBytes - 2).toString("utf16le");
      const type = directory.readUInt8(offset + 66);
      const start = directory.readUInt32LE(offset + 116);
      const size = Number(directory.readBigUInt64LE(offset + 120));
      // Entry zero is the root, and its "stream" is where mini sectors live.
      if (offset === 0) {
        miniStreamStart = start;
        miniStreamSize = size;
        continue;
      }
      if (type !== STREAM_TYPE || size <= 0) continue;
      if (!streams.has(name)) streams.set(name, { start, size });
    }
    const miniStream = miniStreamStart <= MAX_REGULAR_SECTOR
      ? this.#readSectors(miniStreamStart, miniStreamSize)
      : Buffer.alloc(0);
    return { streams, miniStream };
  }

  #readSectors(start: number, size: number): Buffer {
    const chunks: Buffer[] = [];
    let sector = start;
    let remaining = size;
    for (let visited = 0; sector <= MAX_REGULAR_SECTOR && remaining > 0 && visited < MAX_CHAIN_SECTORS; visited += 1) {
      const offset = this.#sectorOffset(sector);
      const take = Math.min(this.#sectorSize, remaining);
      chunks.push(this.#buffer.subarray(offset, offset + take));
      remaining -= take;
      const next = this.#fat[sector];
      if (next === undefined || next === FREE_SECTOR) break;
      sector = next;
    }
    return Buffer.concat(chunks);
  }

  #readMini(start: number, size: number): Buffer {
    const chunks: Buffer[] = [];
    let sector = start;
    let remaining = size;
    for (let visited = 0; sector <= MAX_REGULAR_SECTOR && remaining > 0 && visited < MAX_CHAIN_SECTORS; visited += 1) {
      const offset = sector * this.#miniSectorSize;
      if (offset >= this.#miniStream.length) break;
      const take = Math.min(this.#miniSectorSize, remaining);
      chunks.push(this.#miniStream.subarray(offset, offset + take));
      remaining -= take;
      const next = this.#miniFat[sector];
      if (next === undefined || next === FREE_SECTOR) break;
      sector = next;
    }
    return Buffer.concat(chunks);
  }

  /** Sector numbering starts after the 512-byte header, whatever the sector size. */
  #sectorOffset(sector: number): number {
    const offset = 512 + sector * this.#sectorSize;
    if (offset < 0 || offset + this.#sectorSize > this.#buffer.length) {
      throw new Error("Compound document points past the end of the file");
    }
    return offset;
  }
}

export function looksLikeOle(buffer: Buffer): boolean {
  return buffer.length >= 512 && buffer.subarray(0, 8).equals(SIGNATURE);
}
