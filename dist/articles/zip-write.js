import { crc32, deflateRawSync } from "node:zlib";
/**
 * MS-DOS date for 1980-01-01, the epoch the format starts at. A zeroed field
 * decodes as month 0 day 0, which strict readers reject outright and lenient
 * ones show as "1980-00-00"; the parts carry no meaningful time of their own,
 * so they all take this one valid stamp and the output stays byte-identical
 * between runs.
 */
const DOS_EPOCH_DATE = (1 << 5) | 1;
const DOS_EPOCH_TIME = 0;
/**
 * Writes a ZIP that Office and WPS can open. Parts are deflated when that
 * actually shrinks them; everything else is stored. No extra fields, no
 * comment, so the central directory stays trivial to read back.
 */
export function writeZip(files) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const file of files) {
        const name = Buffer.from(file.name.replaceAll("\\", "/"), "utf8");
        const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, "utf8");
        const compressed = deflateRawSync(data);
        const deflate = compressed.length < data.length;
        const payload = deflate ? compressed : data;
        const method = deflate ? 8 : 0;
        const checksum = crc32(data) >>> 0;
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(method, 8);
        local.writeUInt16LE(DOS_EPOCH_TIME, 10);
        local.writeUInt16LE(DOS_EPOCH_DATE, 12);
        local.writeUInt32LE(checksum, 14);
        local.writeUInt32LE(payload.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(name.length, 26);
        locals.push(local, name, payload);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(method, 10);
        central.writeUInt16LE(DOS_EPOCH_TIME, 12);
        central.writeUInt16LE(DOS_EPOCH_DATE, 14);
        central.writeUInt32LE(checksum, 16);
        central.writeUInt32LE(payload.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE(offset, 42);
        centrals.push(central, name);
        offset += local.length + name.length + payload.length;
    }
    const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, ...centrals, end]);
}
//# sourceMappingURL=zip-write.js.map