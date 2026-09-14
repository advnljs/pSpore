import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { BUNDLED_MARKER } from "./bundled-skills.js";
const SKILL_FILE = "SKILL.md";
/** How far below a top-level entry `SKILL.md` is looked for, matching real-world nesting like `suite/tool/SKILL.md`. */
const MAX_DEPTH = 3;
const MAX_SKILLS = 128;
const MAX_SKILL_BYTES = 256 * 1024;
/** Pi warns above this; the whole catalog sits in every system prompt, so it is a hard cap here. */
const MAX_DESCRIPTION_CHARS = 1_024;
/** A description guessed from the body only has to say what the skill is for. */
const MAX_DERIVED_DESCRIPTION_CHARS = 280;
export async function scanWorkspaceSkills(root, options = {}) {
    const managed = options.managedNames ?? new Set();
    const reserved = options.reservedNames ?? new Map();
    const entries = await listDirectory(root);
    if (!entries)
        return { skills: [], catalog: [] };
    const candidates = [];
    const catalog = [];
    const visited = new Set();
    for (const name of entries) {
        if (name.startsWith(".") || name === "node_modules" || managed.has(name))
            continue;
        const path = join(root, name);
        const kind = await entryKind(path);
        if (kind === "broken") {
            if (await lstat(path).then((stats) => stats.isSymbolicLink(), () => false)) {
                catalog.push(skipped(name, path, "symbolic link target does not exist"));
            }
        }
        else if (kind === "file") {
            if (extname(name).toLowerCase() === ".md")
                candidates.push({ file: path, fallbackName: basename(name, extname(name)), rootFile: true });
        }
        else if (kind === "directory") {
            const real = await realpath(path).catch(() => path);
            if (visited.has(real))
                continue;
            visited.add(real);
            // A materialized copy an older release left behind belongs to pSpore, not the user.
            if (await isFile(join(path, BUNDLED_MARKER)))
                continue;
            const found = await findSkillFiles(path, 0, visited);
            if (found.length === 0) {
                catalog.push(skipped(name, join(path, SKILL_FILE), await missingEntryPointMessage(path)));
                continue;
            }
            for (const file of found)
                candidates.push({ file, fallbackName: basename(dirname(file)), rootFile: false });
        }
    }
    const skills = [];
    const owners = new Map();
    for (const candidate of candidates) {
        if (skills.length >= MAX_SKILLS) {
            catalog.push(skipped(candidate.fallbackName, candidate.file, `more than ${MAX_SKILLS} workspace skills; the rest are not loaded`));
            continue;
        }
        const resolved = await resolveCandidate(candidate);
        if (!resolved)
            continue;
        if (resolved.kind === "skipped") {
            catalog.push(resolved.entry);
            continue;
        }
        const { skill, notes } = resolved;
        const reservedBy = reserved.get(skill.name);
        const takenBy = owners.get(skill.name);
        if (reservedBy || takenBy) {
            catalog.push({
                name: skill.name,
                source: "workspace",
                status: "shadowed",
                path: skill.filePath,
                description: skill.description,
                message: reservedBy
                    ? `the ${reservedBy} skill named ${skill.name} takes precedence; rename this one to load it`
                    : `${takenBy} already uses the name ${skill.name}; rename this one to load it`,
            });
            continue;
        }
        owners.set(skill.name, skill.filePath);
        skills.push(skill);
        catalog.push({
            name: skill.name,
            source: "workspace",
            status: "active",
            path: skill.filePath,
            description: skill.description,
            ...(notes.length > 0 ? { message: notes.join("; ") } : {}),
        });
    }
    catalog.sort((left, right) => left.name.localeCompare(right.name) || left.path.localeCompare(right.path));
    return { skills, catalog };
}
async function resolveCandidate(candidate) {
    const { file, fallbackName } = candidate;
    // A stray root-level file that cannot be read as a skill is simply not one.
    const unreadable = (message) => candidate.rootFile ? undefined : { kind: "skipped", entry: skipped(fallbackName, file, message) };
    const size = await stat(file).then((stats) => stats.size, () => -1);
    if (size < 0)
        return unreadable("cannot be read");
    if (size > MAX_SKILL_BYTES)
        return unreadable(`is larger than ${MAX_SKILL_BYTES / 1024} KiB`);
    let source;
    try {
        source = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(file)).replace(/^﻿/, "");
    }
    catch (error) {
        return unreadable(error instanceof TypeError ? "is not UTF-8 text; save it as UTF-8" : "cannot be read");
    }
    const notes = [];
    const { frontmatter, body, lenient } = readFrontmatter(source);
    if (candidate.rootFile && typeof frontmatter["description"] !== "string")
        return undefined;
    if (lenient)
        notes.push("frontmatter is not valid YAML, so it was read line by line");
    const declaredName = typeof frontmatter["name"] === "string" ? frontmatter["name"].trim() : "";
    const name = declaredName || fallbackName;
    let description = typeof frontmatter["description"] === "string" ? collapse(frontmatter["description"]) : "";
    if (!description) {
        description = deriveSkillDescription(body);
        if (!description) {
            return {
                kind: "skipped",
                entry: skipped(name, file, "has no description in its frontmatter and no text to describe it with"),
            };
        }
        notes.push("no description in the frontmatter, so its opening text is used");
    }
    if (description.length > MAX_DESCRIPTION_CHARS) {
        description = `${description.slice(0, MAX_DESCRIPTION_CHARS - 1)}…`;
        notes.push(`description shortened to ${MAX_DESCRIPTION_CHARS} characters`);
    }
    const invocation = frontmatter["disable-model-invocation"];
    return {
        kind: "skill",
        skill: {
            name,
            description,
            filePath: file,
            baseDir: dirname(file),
            disableModelInvocation: invocation === true || invocation === "true",
        },
        notes,
    };
}
/**
 * Pi's YAML reading first, so everything Pi accepts means the same here; a
 * line-by-line `key: value` read when YAML rejects it, which recovers the
 * common unquoted-colon mistake without guessing at anything more structured.
 */
function readFrontmatter(source) {
    try {
        const parsed = parseFrontmatter(source);
        const frontmatter = isRecord(parsed.frontmatter) ? parsed.frontmatter : {};
        return { frontmatter, body: parsed.body, lenient: false };
    }
    catch {
        const normalized = source.replace(/\r\n?/g, "\n");
        const end = normalized.indexOf("\n---", 3);
        const block = normalized.slice(4, end);
        const frontmatter = {};
        for (const line of block.split("\n")) {
            const match = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
            if (!match?.[1])
                continue;
            let value = (match[2] ?? "").trim();
            const quote = value[0];
            if (value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote))
                value = value.slice(1, -1);
            if (value)
                frontmatter[match[1]] = value;
        }
        return { frontmatter, body: normalized.slice(end + 4).trim(), lenient: true };
    }
}
/**
 * What a skill without a declared description is for, taken from its opening:
 * the first heading and the first paragraph after it. Code, tables, quotes of
 * markup and further headings are not descriptions and are passed over.
 */
export function deriveSkillDescription(body) {
    let heading = "";
    let text = "";
    let lines = 0;
    let fenced = false;
    for (const raw of body.replace(/\r\n?/g, "\n").split("\n")) {
        const line = raw.trim();
        if (/^(```|~~~)/.test(line)) {
            fenced = !fenced;
            if (lines > 0)
                break;
            continue;
        }
        if (fenced)
            continue;
        if (!line) {
            if (lines > 0)
                break;
            continue;
        }
        const headingMatch = /^#{1,6}\s+(.*)$/.exec(line);
        if (headingMatch) {
            if (lines > 0)
                break;
            if (!heading)
                heading = plain(headingMatch[1] ?? "");
            continue;
        }
        if (line.startsWith("|") || line.startsWith("<") || /^[-*_]{3,}$/.test(line)) {
            if (lines > 0)
                break;
            continue;
        }
        const listItem = /^(?:[-*+]|\d+[.)])\s+/.test(line);
        const content = plain(line.replace(/^(?:>\s*|[-*+]\s+|\d+[.)]\s+)/, ""));
        if (!content)
            continue;
        text = lines === 0 ? content : joinLines(text, content, listItem);
        lines += 1;
    }
    text = collapse(text);
    const combined = heading && text ? `${heading} — ${text}` : heading || text;
    return combined.length <= MAX_DERIVED_DESCRIPTION_CHARS
        ? combined
        : `${combined.slice(0, MAX_DERIVED_DESCRIPTION_CHARS - 1)}…`;
}
async function findSkillFiles(directory, depth, visited) {
    const entries = await listDirectory(directory);
    if (!entries)
        return [];
    if (entries.includes(SKILL_FILE) && (await isFile(join(directory, SKILL_FILE))))
        return [join(directory, SKILL_FILE)];
    if (depth >= MAX_DEPTH)
        return [];
    const found = [];
    for (const name of entries) {
        if (name.startsWith(".") || name === "node_modules")
            continue;
        const path = join(directory, name);
        if ((await entryKind(path)) !== "directory")
            continue;
        const real = await realpath(path).catch(() => path);
        if (visited.has(real))
            continue;
        visited.add(real);
        found.push(...(await findSkillFiles(path, depth + 1, visited)));
    }
    return found;
}
/** Explains a skill directory without an entry point, naming what it does hold. */
async function missingEntryPointMessage(directory) {
    const entries = (await listDirectory(directory)) ?? [];
    const nearMiss = entries.find((name) => name.toLowerCase() === "skill.md");
    if (nearMiss)
        return `${nearMiss} must be named exactly ${SKILL_FILE}`;
    const markdown = entries.filter((name) => extname(name).toLowerCase() === ".md");
    if (markdown.length === 0)
        return `no ${SKILL_FILE} found`;
    const shown = markdown.slice(0, 3).join(", ");
    return `no ${SKILL_FILE} found (has ${shown}${markdown.length > 3 ? ", …" : ""}); add a ${SKILL_FILE} that describes the skill and points to the others`;
}
async function listDirectory(path) {
    try {
        return (await readdir(path)).sort();
    }
    catch {
        return undefined;
    }
}
async function entryKind(path) {
    try {
        const stats = await stat(path);
        return stats.isDirectory() ? "directory" : stats.isFile() ? "file" : "other";
    }
    catch {
        return "broken";
    }
}
async function isFile(path) {
    return stat(path).then((stats) => stats.isFile(), () => false);
}
function skipped(name, path, message) {
    return { name, source: "workspace", status: "skipped", path, message };
}
const CJK = /[⺀-鿿豈-﫿＀-￯　-〿]/;
/**
 * Rejoins a wrapped paragraph: Chinese and Japanese text wraps without a space,
 * and list items keep a separator so they do not run together.
 */
function joinLines(previous, next, listItem) {
    const cjk = CJK.test(previous.slice(-1)) || CJK.test(next.slice(0, 1));
    if (listItem)
        return `${previous}${cjk ? "；" : "; "}${next}`;
    return `${previous}${cjk ? "" : " "}${next}`;
}
function plain(value) {
    return value.replace(/\*\*|__|`/g, "").trim();
}
function collapse(value) {
    return value.replace(/\s+/g, " ").trim();
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=workspace-skills.js.map