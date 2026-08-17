import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, open, readdir, realpath, rename, rm, stat, } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
const execFileAsync = promisify(execFile);
const MAX_FILES = 256;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_DEPTH = 12;
const MAX_RELATIVE_PATH = 240;
const PLUGIN_MANIFEST = "pspore.plugin.json";
const CONTRIBUTIONS = ["trigger", "tool", "retrieval", "executor", "transport"];
export async function resolveStagedResource(stagingRoot, input) {
    if (!input.trim() || input.includes("\0"))
        throw new Error("Staging path must be non-empty");
    const canonicalRoot = await realpath(stagingRoot);
    const candidate = await realpath(isAbsolute(input) ? input : resolve(canonicalRoot, input));
    assertContained(candidate, canonicalRoot, "Staged resource escapes workspace/staging");
    if (!(await stat(candidate)).isDirectory())
        throw new Error(`Staged resource must be a directory: ${candidate}`);
    return candidate;
}
export async function inspectResourceDirectory(directory) {
    const canonical = await realpath(directory);
    if (!(await stat(canonical)).isDirectory())
        throw new Error(`Resource must be a directory: ${canonical}`);
    const files = await scanDirectory(canonical);
    const paths = new Set(files.map((file) => file.path));
    const hasSkill = paths.has("SKILL.md");
    const hasPlugin = paths.has(PLUGIN_MANIFEST);
    if (hasSkill === hasPlugin) {
        throw new Error(`Resource must contain exactly one of SKILL.md or ${PLUGIN_MANIFEST}`);
    }
    const digest = digestFiles(files);
    const packageMetadata = packageDetails(files);
    const base = {
        version: 1,
        sourcePath: canonical,
        digest,
        files: files.map(({ content: _content, ...file }) => file),
        totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
        dependencies: packageMetadata.dependencies,
        lifecycleScripts: packageMetadata.lifecycleScripts,
    };
    if (hasSkill) {
        const loaded = loadSkillsFromDir({ dir: canonical, source: "pspore-staging" });
        const expectedPath = await realpath(join(canonical, "SKILL.md"));
        const skill = loaded.skills.find((candidate) => resolve(candidate.filePath) === expectedPath);
        if (!skill || loaded.skills.length !== 1) {
            throw new Error("A staged skill must contain exactly one root SKILL.md with name and description");
        }
        validateName(skill.name, "skill name");
        const diagnostics = loaded.diagnostics.map((diagnostic) => `${diagnostic.type}: ${diagnostic.message}`);
        return {
            directory: canonical,
            files,
            inspection: {
                ...base,
                kind: "skill",
                name: skill.name,
                resourceVersion: "unversioned",
                description: bounded(skill.description, 1_024),
                entry: "SKILL.md",
                capabilities: [],
                contributes: [],
                diagnostics,
                installable: !loaded.diagnostics.some((diagnostic) => diagnostic.type === "error" || diagnostic.type === "collision"),
            },
        };
    }
    const manifestFile = files.find((file) => file.path === PLUGIN_MANIFEST);
    if (!manifestFile)
        throw new Error(`Missing ${PLUGIN_MANIFEST}`);
    const manifest = parseManifest(parseJson(manifestFile.content, PLUGIN_MANIFEST));
    const entry = files.find((file) => file.path === manifest.entry);
    if (!entry)
        throw new Error(`Host plugin entry is missing from its package: ${manifest.entry}`);
    if (!/\.(?:cjs|mjs|js)$/.test(entry.path))
        throw new Error("Host plugin entry must be a .js, .mjs, or .cjs file");
    const diagnostics = [];
    if (packageMetadata.dependencies.length > 0) {
        diagnostics.push("Host plugin dependencies are not installed by pSpore v1; bundle them or use a dependency-free entry");
    }
    if (packageMetadata.lifecycleScripts.length > 0) {
        diagnostics.push(`Lifecycle scripts will never run: ${packageMetadata.lifecycleScripts.join(", ")}`);
    }
    try {
        await execFileAsync(process.execPath, ["--check", join(canonical, manifest.entry)], {
            timeout: 5_000,
            maxBuffer: 256 * 1024,
            encoding: "utf8",
        });
    }
    catch (error) {
        diagnostics.push(`Entry syntax check failed: ${bounded(toError(error).message, 1_000)}`);
    }
    return {
        directory: canonical,
        files,
        inspection: {
            ...base,
            kind: "host-plugin",
            name: manifest.name,
            resourceVersion: manifest.version,
            entry: manifest.entry,
            capabilities: manifest.capabilities,
            contributes: manifest.contributes,
            diagnostics,
            installable: packageMetadata.dependencies.length === 0 && !diagnostics.some((item) => item.startsWith("Entry syntax")),
        },
    };
}
export async function installSnapshot(snapshot, destination) {
    const parent = dirname(destination);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    try {
        const existing = await inspectResourceDirectory(destination);
        if (existing.inspection.digest !== snapshot.inspection.digest) {
            throw new Error(`Installed resource path contains a different digest: ${destination}`);
        }
        return;
    }
    catch (error) {
        if (!isMissing(error))
            throw error;
    }
    const temporary = join(parent, `.${basename(destination)}.${randomUUID()}.tmp`);
    await mkdir(temporary, { mode: 0o700 });
    try {
        for (const file of snapshot.files) {
            const output = join(temporary, file.path);
            assertContained(output, temporary, "Resource output path escaped install directory");
            await mkdir(dirname(output), { recursive: true, mode: 0o700 });
            const handle = await open(output, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, file.executable ? 0o700 : 0o600);
            try {
                await handle.writeFile(file.content);
                await handle.sync();
            }
            finally {
                await handle.close();
            }
        }
        const installed = await inspectResourceDirectory(temporary);
        if (installed.inspection.digest !== snapshot.inspection.digest) {
            throw new Error("Installed resource digest changed during copy");
        }
        await rename(temporary, destination);
        const directoryHandle = await open(parent, "r");
        try {
            await directoryHandle.sync();
        }
        finally {
            await directoryHandle.close();
        }
    }
    catch (error) {
        await rm(temporary, { recursive: true, force: true });
        if (isAlreadyExists(error)) {
            const existing = await inspectResourceDirectory(destination);
            if (existing.inspection.digest === snapshot.inspection.digest)
                return;
        }
        throw error;
    }
}
export function resourceInstallPath(kind, name, digest, skillsRoot, pluginsRoot) {
    validateName(name, "resource name");
    validateDigest(digest, "resource digest");
    return kind === "skill"
        ? join(skillsRoot, ".installed", name, digest)
        : join(pluginsRoot, name, digest);
}
export function validateDigest(value, path) {
    if (!/^[a-f0-9]{64}$/.test(value))
        throw new Error(`${path} must be a lowercase SHA-256 digest`);
}
export function validateName(value, path) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value) || value.includes("--")) {
        throw new Error(`${path} must be 1-64 lowercase letters, numbers, or single hyphens`);
    }
}
export function resourceKey(kind, name) {
    return `${kind}:${name}`;
}
function parseManifest(value) {
    const manifest = record(value, PLUGIN_MANIFEST);
    exactKeys(manifest, ["apiVersion", "name", "version", "entry", "capabilities", "contributes"], PLUGIN_MANIFEST);
    if (manifest["apiVersion"] !== 1)
        throw new Error(`${PLUGIN_MANIFEST}.apiVersion must be 1`);
    const name = nonEmptyString(manifest["name"], `${PLUGIN_MANIFEST}.name`);
    validateName(name, `${PLUGIN_MANIFEST}.name`);
    const version = nonEmptyString(manifest["version"], `${PLUGIN_MANIFEST}.version`);
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
        throw new Error(`${PLUGIN_MANIFEST}.version must be an explicit semantic version`);
    }
    const entry = normalizedRelativePath(manifest["entry"], `${PLUGIN_MANIFEST}.entry`);
    const capabilities = uniqueStrings(manifest["capabilities"], `${PLUGIN_MANIFEST}.capabilities`, validateCapability);
    const contributes = uniqueStrings(manifest["contributes"], `${PLUGIN_MANIFEST}.contributes`, (item, path) => {
        if (!CONTRIBUTIONS.includes(item)) {
            throw new Error(`${path} must be one of: ${CONTRIBUTIONS.join(", ")}`);
        }
    });
    return { apiVersion: 1, name, version, entry, capabilities, contributes };
}
function packageDetails(files) {
    const file = files.find((candidate) => candidate.path === "package.json");
    if (!file)
        return { dependencies: [], lifecycleScripts: [] };
    const value = record(parseJson(file.content, "package.json"), "package.json");
    const dependencies = [];
    for (const [field, kind] of [
        ["dependencies", "dependency"],
        ["optionalDependencies", "optional"],
        ["peerDependencies", "peer"],
    ]) {
        const section = value[field];
        if (section === undefined)
            continue;
        for (const [name, version] of Object.entries(record(section, `package.json.${field}`))) {
            const exact = nonEmptyString(version, `package.json.${field}.${name}`);
            if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(exact)) {
                throw new Error(`package.json.${field}.${name} must pin an exact semantic version`);
            }
            dependencies.push({ name, version: exact, kind });
        }
    }
    dependencies.sort((left, right) => left.name.localeCompare(right.name) || left.kind.localeCompare(right.kind));
    const scriptsValue = value["scripts"];
    const lifecycleScripts = scriptsValue === undefined
        ? []
        : Object.keys(record(scriptsValue, "package.json.scripts"))
            .filter((name) => /^(?:pre|post)?install$|^prepare$/.test(name))
            .sort();
    return { dependencies, lifecycleScripts };
}
async function scanDirectory(root) {
    const files = [];
    let totalBytes = 0;
    const visit = async (directory, depth) => {
        if (depth > MAX_DEPTH)
            throw new Error(`Resource directory depth exceeds ${MAX_DEPTH}`);
        const entries = await readdir(directory, { withFileTypes: true });
        entries.sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
            if (entry.name === ".git" || entry.name === "node_modules") {
                throw new Error(`Resource cannot contain ${entry.name}`);
            }
            const path = join(directory, entry.name);
            const relativePath = relative(root, path);
            if (!relativePath || relativePath.length > MAX_RELATIVE_PATH || isAbsolute(relativePath) || relativePath.startsWith(`..${sep}`)) {
                throw new Error(`Invalid resource path: ${relativePath}`);
            }
            if (entry.isSymbolicLink())
                throw new Error(`Resource cannot contain symbolic links: ${relativePath}`);
            if (entry.isDirectory()) {
                await visit(path, depth + 1);
                continue;
            }
            if (!entry.isFile())
                throw new Error(`Resource cannot contain special files: ${relativePath}`);
            if (files.length >= MAX_FILES)
                throw new Error(`Resource contains more than ${MAX_FILES} files`);
            const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
                const metadata = await handle.stat();
                if (!metadata.isFile())
                    throw new Error(`Resource path is no longer a regular file: ${relativePath}`);
                if (metadata.size > MAX_FILE_BYTES)
                    throw new Error(`Resource file exceeds ${MAX_FILE_BYTES} bytes: ${relativePath}`);
                totalBytes += metadata.size;
                if (totalBytes > MAX_TOTAL_BYTES)
                    throw new Error(`Resource exceeds ${MAX_TOTAL_BYTES} total bytes`);
                const content = await handle.readFile();
                if (content.byteLength !== metadata.size)
                    throw new Error(`Resource file changed while inspecting: ${relativePath}`);
                files.push({
                    path: relativePath.split(sep).join("/"),
                    bytes: content.byteLength,
                    sha256: createHash("sha256").update(content).digest("hex"),
                    executable: (metadata.mode & 0o111) !== 0,
                    content,
                });
            }
            finally {
                await handle.close();
            }
        }
    };
    await visit(root, 0);
    if (files.length === 0)
        throw new Error("Resource directory is empty");
    return files.sort((left, right) => left.path.localeCompare(right.path));
}
function digestFiles(files) {
    const digest = createHash("sha256");
    digest.update("pspore-resource-v1\0");
    for (const file of files) {
        digest.update(file.path);
        digest.update("\0");
        digest.update(file.executable ? "x" : "-");
        digest.update("\0");
        digest.update(String(file.bytes));
        digest.update("\0");
        digest.update(file.content);
        digest.update("\0");
    }
    return digest.digest("hex");
}
function parseJson(content, path) {
    try {
        return JSON.parse(content.toString("utf8"));
    }
    catch {
        throw new Error(`${path} must contain valid JSON`);
    }
}
function normalizedRelativePath(value, path) {
    const input = nonEmptyString(value, path);
    if (input.includes("\\") || input.includes("\0") || isAbsolute(input))
        throw new Error(`${path} must be a portable relative path`);
    const normalized = input.split("/").filter(Boolean).join("/");
    if (!normalized || normalized !== input || normalized.split("/").some((part) => part === "." || part === "..")) {
        throw new Error(`${path} must be a normalized relative path`);
    }
    return normalized;
}
function validateCapability(value, path) {
    if (!/^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*$/.test(value))
        throw new Error(`${path} is not a valid capability`);
}
function uniqueStrings(value, path, validate) {
    if (!Array.isArray(value) || value.length > 64)
        throw new Error(`${path} must be an array with at most 64 entries`);
    const result = value.map((item, index) => {
        const text = nonEmptyString(item, `${path}[${index}]`);
        validate(text, `${path}[${index}]`);
        return text;
    });
    if (new Set(result).size !== result.length)
        throw new Error(`${path} must not contain duplicates`);
    return result;
}
function exactKeys(value, keys, path) {
    const expected = new Set(keys);
    const unknown = Object.keys(value).filter((key) => !expected.has(key));
    if (unknown.length > 0)
        throw new Error(`${path} contains unknown keys: ${unknown.join(", ")}`);
    for (const key of keys)
        if (!(key in value))
            throw new Error(`${path}.${key} is required`);
}
function record(value, path) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new Error(`${path} must be an object`);
    return value;
}
function nonEmptyString(value, path) {
    if (typeof value !== "string" || !value.trim())
        throw new Error(`${path} must be a non-empty string`);
    return value;
}
function assertContained(path, root, message) {
    const canonicalRoot = resolve(root);
    const candidate = resolve(path);
    if (candidate !== canonicalRoot && !candidate.startsWith(`${canonicalRoot}${sep}`))
        throw new Error(`${message}: ${candidate}`);
}
function bounded(value, maximum) {
    return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}
function isMissing(error) {
    return isNodeError(error) && error.code === "ENOENT";
}
function isAlreadyExists(error) {
    return isNodeError(error) && (error.code === "EEXIST" || error.code === "ENOTEMPTY");
}
function isNodeError(error) {
    return error instanceof Error && "code" in error;
}
function toError(error) {
    return error instanceof Error ? error : new Error(String(error));
}
//# sourceMappingURL=resource-inspector.js.map