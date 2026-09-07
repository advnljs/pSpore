import { chmod, lstat, mkdir, readdir, readFile, readlink, realpath, rm, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
/** Written beside a linked skill so a later startup can tell ours from the user's. */
export const BUNDLED_MARKER = ".pspore-bundled.json";
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
/**
 * Candidate roots for the release's bundled skills, most specific first.
 *
 * The build copies `bundled-skills/` into `dist/`, so a packaged install finds
 * it one level up from this module; a `tsx` run from the source tree finds the
 * repository copy two levels up.
 *
 * Inside an Electron package the module lives in `app.asar`, where entries are
 * not real files. The skills are therefore unpacked next to the archive, and the
 * `.asar` segment is rewritten so the path can be read, symlinked to, and
 * executed like any other directory.
 */
export function bundledSkillsRoots(moduleUrl = import.meta.url) {
    const here = dirname(fileURLToPath(moduleUrl));
    const candidates = [
        resolve(here, "..", "bundled-skills"),
        resolve(here, "..", "..", "bundled-skills"),
    ];
    const unpacked = candidates
        .filter((path) => path.includes(`.asar${sep}`))
        .map((path) => path.replace(`.asar${sep}`, `.asar.unpacked${sep}`));
    return [...unpacked, ...candidates];
}
/** First candidate root that actually exists, or undefined when none ship. */
export async function resolveBundledSkillsRoot(moduleUrl = import.meta.url) {
    for (const candidate of bundledSkillsRoots(moduleUrl)) {
        try {
            if ((await lstat(candidate)).isDirectory())
                return candidate;
        }
        catch {
            // Try the next candidate; a build without bundled skills has none.
        }
    }
    return undefined;
}
/** Reads every bundled skill shipped in `root`, skipping anything malformed. */
export async function readBundledSkills(root) {
    let entries;
    try {
        entries = (await readdir(root, { withFileTypes: true }))
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort();
    }
    catch (error) {
        // A build without bundled skills is legitimate; callers treat it as "none".
        if (isMissing(error))
            return [];
        throw error;
    }
    const skills = [];
    for (const name of entries) {
        const sourcePath = join(root, name);
        const skill = await readBundledSkill(sourcePath, name);
        if (skill)
            skills.push(skill);
    }
    return skills;
}
async function readBundledSkill(sourcePath, directoryName) {
    let source;
    try {
        source = await readFile(join(sourcePath, "SKILL.md"), "utf8");
    }
    catch (error) {
        if (isMissing(error))
            return undefined;
        throw error;
    }
    const frontmatter = parseFrontmatter(source);
    const name = frontmatter["name"] ?? directoryName;
    if (!NAME_PATTERN.test(name) || name.includes("--"))
        return undefined;
    const version = frontmatter["version"] ?? "0.0.0";
    if (!VERSION_PATTERN.test(version))
        return undefined;
    const description = frontmatter["description"];
    return {
        name,
        version,
        ...(description === undefined ? {} : { description }),
        sourcePath,
    };
}
/**
 * Links every bundled skill into `skillsRoot`, replacing an older linked copy.
 * A directory the user created themselves is never overwritten.
 */
export async function linkBundledSkills(skills, skillsRoot) {
    if (skills.length === 0)
        return [];
    await mkdir(skillsRoot, { recursive: true, mode: 0o700 });
    const results = [];
    for (const skill of skills) {
        results.push(await linkBundledSkill(skill, skillsRoot));
    }
    return results;
}
async function linkBundledSkill(skill, skillsRoot) {
    const targetPath = join(skillsRoot, skill.name);
    const base = { name: skill.name, version: skill.version, targetPath };
    try {
        const existing = await describeExisting(targetPath);
        if (existing.kind === "absent") {
            await createLink(skill, targetPath);
            return { ...base, action: "linked" };
        }
        if (existing.kind === "user") {
            return {
                ...base,
                action: "kept-user-copy",
                message: `${targetPath} was not created by pSpore, so the bundled ${skill.name} ${skill.version} was not linked over it`,
            };
        }
        if (existing.kind === "link" && existing.target === skill.sourcePath) {
            return { ...base, action: "current" };
        }
        // A link left by another install path is stale by definition, so it is
        // replaced without consulting versions.
        if (existing.kind === "link") {
            await replaceLink(skill, targetPath);
            return { ...base, action: "relinked" };
        }
        // A materialized copy from an older pSpore: only a newer bundled version
        // may replace it, so a user running an older release keeps what works.
        if (compareVersions(skill.version, existing.version) <= 0) {
            return { ...base, action: "current", previousVersion: existing.version };
        }
        await replaceLink(skill, targetPath);
        return { ...base, action: "upgraded", previousVersion: existing.version };
    }
    catch (error) {
        return { ...base, action: "failed", message: toMessage(error) };
    }
}
async function describeExisting(targetPath) {
    let stats;
    try {
        stats = await lstat(targetPath);
    }
    catch (error) {
        if (isMissing(error))
            return { kind: "absent" };
        throw error;
    }
    if (stats.isSymbolicLink()) {
        const target = await readlink(targetPath);
        const resolved = isAbsolute(target) ? target : resolve(dirname(targetPath), target);
        // A link into a release that no longer exists still counts as ours to replace.
        const canonical = await realpath(resolved).catch(() => resolved);
        return { kind: "link", target: canonical };
    }
    if (!stats.isDirectory())
        return { kind: "user" };
    const marker = await readMarker(join(targetPath, BUNDLED_MARKER));
    return marker ? { kind: "bundled", version: marker } : { kind: "user" };
}
async function readMarker(path) {
    try {
        const parsed = JSON.parse(await readFile(path, "utf8"));
        if (typeof parsed !== "object" || parsed === null)
            return undefined;
        const version = parsed["version"];
        return typeof version === "string" && VERSION_PATTERN.test(version) ? version : "0.0.0";
    }
    catch {
        return undefined;
    }
}
async function createLink(skill, targetPath) {
    // The source lives inside the read-only application payload, so a symlink is
    // what keeps the workspace copy following an in-place overlay upgrade.
    await symlink(await realpath(skill.sourcePath), targetPath, "dir");
}
async function replaceLink(skill, targetPath) {
    await rm(targetPath, { recursive: true, force: true });
    await createLink(skill, targetPath);
}
/** Numeric SemVer comparison; a prerelease sorts before its own release. */
export function compareVersions(left, right) {
    const [leftCore = "", leftPre = ""] = left.split("-", 2);
    const [rightCore = "", rightPre = ""] = right.split("-", 2);
    const leftParts = leftCore.split(".").map(Number);
    const rightParts = rightCore.split(".").map(Number);
    for (let index = 0; index < 3; index += 1) {
        const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
        if (difference !== 0)
            return difference < 0 ? -1 : 1;
    }
    if (leftPre === rightPre)
        return 0;
    if (!leftPre)
        return 1;
    if (!rightPre)
        return -1;
    return leftPre < rightPre ? -1 : 1;
}
/** Minimal `key: value` frontmatter reader; values are never interpreted further. */
function parseFrontmatter(source) {
    const normalized = source.replace(/^﻿/, "");
    if (!normalized.startsWith("---"))
        return {};
    const end = normalized.indexOf("\n---", 3);
    if (end < 0)
        return {};
    const block = normalized.slice(normalized.indexOf("\n", 3) + 1, end);
    const values = {};
    for (const line of block.split("\n")) {
        const separator = line.indexOf(":");
        if (separator <= 0)
            continue;
        const key = line.slice(0, separator).trim();
        let value = line.slice(separator + 1).trim();
        const quote = value[0];
        if (value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote)) {
            value = value.slice(1, -1);
        }
        if (key)
            values[key] = value;
    }
    return values;
}
/** Restores the executable bit that a zip round-trip or asar copy can drop. */
export async function ensureSkillExecutables(skill, relativePaths) {
    for (const relative of relativePaths) {
        await chmod(join(skill.sourcePath, relative), 0o755).catch(() => undefined);
    }
}
function isMissing(error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function toMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=bundled-skills.js.map