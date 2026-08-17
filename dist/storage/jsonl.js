import { randomUUID } from "node:crypto";
import { copyFile, mkdir, open, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
export async function readJsonLinesRecovering(path, recoveryDirectory, idFactory = randomUUID) {
    const content = await readFile(path);
    const lines = [];
    let start = 0;
    for (let index = 0; index < content.byteLength; index++) {
        if (content[index] !== 0x0a)
            continue;
        lines.push({ start, end: index, complete: true });
        start = index + 1;
    }
    if (start < content.byteLength)
        lines.push({ start, end: content.byteLength, complete: false });
    const nonEmpty = lines.filter((line) => content.subarray(line.start, line.end).toString("utf8").trim());
    const values = [];
    for (let index = 0; index < nonEmpty.length; index++) {
        const line = nonEmpty[index];
        if (!line)
            continue;
        const text = content.subarray(line.start, line.end).toString("utf8").trim();
        try {
            values.push(JSON.parse(text));
        }
        catch (error) {
            if (index !== nonEmpty.length - 1)
                throw new Error(`Malformed JSONL middle record in ${path}`, { cause: error });
            await mkdir(recoveryDirectory, { recursive: true, mode: 0o700 });
            const recoveryPath = join(recoveryDirectory, `${basename(path)}.${idFactory()}.broken`);
            await copyFile(path, recoveryPath);
            const file = await open(path, "r+");
            try {
                await file.truncate(line.start);
                await file.sync();
            }
            finally {
                await file.close();
            }
            break;
        }
    }
    return values;
}
//# sourceMappingURL=jsonl.js.map