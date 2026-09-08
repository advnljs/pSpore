import { inflateRawSync } from "node:zlib";

/**
 * Just enough ZIP to read an Office Open XML package.
 *
 * Every modern Office format — and everything WPS saves in one — is a ZIP whose
 * parts are deflated, which `node:zlib` already decompresses. A dependency for
 * this would buy nothing and would have to be trusted with user documents, so
 * the central directory is walked here instead.
 */

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const ZIP64_END_LOCATOR = 0x07064b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY = 0x06064b50;

/** The comment that may follow the end-of-central-directory record is 16 bits long. */
const MAX_TRAILING_COMMENT = 0xffff;
const END_RECORD_LENGTH = 22;

const STORED = 0;
const DEFLATED = 8;

/**
 * Ceiling for one inflated part. A crafted archive can claim a small compressed
 * size and expand without bound, and these documents are read on behalf of
 * whoever asked the agent to open them.
 */
const MAX_PART_BYTES = 64 * 1024 * 1024;

interface ZipEntry {
  compressionMethod: number;
  compressedSize: number;
  localHeaderOffset: number;
}

export class ZipArchive {
  readonly #buffer: Buffer;
  readonly #entries: ReadonlyMap<string, ZipEntry>;

  private constructor(buffer: Buffer, entries: ReadonlyMap<string, ZipEntry>) {
    this.#buffer = buffer;
    this.#entries = entries;
  }

  static open(buffer: Buffer): ZipArchive {
    return new ZipArchive(buffer, readCentralDirectory(buffer));
  }

  has(name: string): boolean {
    return this.#entries.has(name);
  }

  /** Part names in the archive, in central-directory order. */
  names(): string[] {
    return [...this.#entries.keys()];
  }

  /** Names matching `pattern`, sorted so `slide2` precedes `slide10`. */
  matching(pattern: RegExp): string[] {
    return this.names().filter((name) => pattern.test(name)).sort(compareNumbered);
  }

  /** Reads one part as UTF-8, or undefined when the package does not carry it. */
  readText(name: string): string | undefined {
    const entry = this.#entries.get(name);
    return entry ? this.#read(entry).toString("utf8") : undefined;
  }

  #read(entry: ZipEntry): Buffer {
    const header = entry.localHeaderOffset;
    if (header + 30 > this.#buffer.length || this.#buffer.readUInt32LE(header) !== LOCAL_FILE_HEADER) {
      throw new Error("Zip entry does not start with a local file header");
    }
    // The local header repeats the name and extra fields with its own lengths;
    // the central directory's copies may differ in size, so these are the ones
    // that locate the data.
    const nameLength = this.#buffer.readUInt16LE(header + 26);
    const extraLength = this.#buffer.readUInt16LE(header + 28);
    const start = header + 30 + nameLength + extraLength;
    const end = start + entry.compressedSize;
    if (end > this.#buffer.length) throw new Error("Zip entry runs past the end of the archive");
    const raw = this.#buffer.subarray(start, end);
    if (entry.compressionMethod === STORED) return raw;
    if (entry.compressionMethod === DEFLATED) return inflateRawSync(raw, { maxOutputLength: MAX_PART_BYTES });
    throw new Error(`Unsupported zip compression method ${entry.compressionMethod}`);
  }
}

/** True when the buffer starts with a local file header, so it is worth opening. */
export function looksLikeZip(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer.readUInt32LE(0) === LOCAL_FILE_HEADER;
}

function readCentralDirectory(buffer: Buffer): Map<string, ZipEntry> {
  const end = findEndRecord(buffer);
  let count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  // A package that needed ZIP64 records the real count and offset in its own
  // trailer, and leaves the 16- and 32-bit fields saturated.
  if (count === 0xffff || offset === 0xffffffff) {
    const zip64 = findZip64Record(buffer, end);
    count = Number(buffer.readBigUInt64LE(zip64 + 32));
    offset = Number(buffer.readBigUInt64LE(zip64 + 48));
  }

  const entries = new Map<string, ZipEntry>();
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_FILE_HEADER) {
      throw new Error("Zip central directory is malformed");
    }
    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    // A duplicate name is the classic way to hide a part from one reader and
    // show it to another, so the first one wins and the rest are ignored.
    if (!entries.has(name)) entries.set(name, { compressionMethod, compressedSize, localHeaderOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function findEndRecord(buffer: Buffer): number {
  const earliest = Math.max(0, buffer.length - END_RECORD_LENGTH - MAX_TRAILING_COMMENT);
  for (let offset = buffer.length - END_RECORD_LENGTH; offset >= earliest; offset -= 1) {
    if (buffer.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) return offset;
  }
  throw new Error("Not a zip archive: no end-of-central-directory record");
}

function findZip64Record(buffer: Buffer, endRecord: number): number {
  const locator = endRecord - 20;
  if (locator < 0 || buffer.readUInt32LE(locator) !== ZIP64_END_LOCATOR) {
    throw new Error("Zip claims ZIP64 sizes without a ZIP64 locator");
  }
  const offset = Number(buffer.readBigUInt64LE(locator + 8));
  if (offset + 56 > buffer.length || buffer.readUInt32LE(offset) !== ZIP64_END_OF_CENTRAL_DIRECTORY) {
    throw new Error("Zip ZIP64 end-of-central-directory record is malformed");
  }
  return offset;
}

/** Orders `sheet2.xml` before `sheet10.xml`, which a plain sort gets backwards. */
function compareNumbered(left: string, right: string): number {
  const leftNumber = Number(/(\d+)/.exec(left)?.[1] ?? Number.NaN);
  const rightNumber = Number(/(\d+)/.exec(right)?.[1] ?? Number.NaN);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber !== rightNumber) {
    return leftNumber - rightNumber;
  }
  return left.localeCompare(right);
}
