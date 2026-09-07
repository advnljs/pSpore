import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";

/**
 * The Electron renderer runs sandboxed with Node integration disabled, so every
 * module reachable from its entry point must stay free of Node built-ins. A
 * violation is invisible to the type checker and to the x64 CI job — it only
 * shows up as the renderer silently failing to load, which reaches CI as an
 * unexplained "renderer never became ready" timeout on the one job that runs a
 * real Electron smoke.
 *
 * Walking the import graph statically catches it at unit-test speed instead.
 */
const ENTRY = resolve(import.meta.dirname, "../../src/desktop/renderer/renderer.ts");

/** Import specifiers that only exist inside a Node process. */
function isNodeBuiltin(specifier: string): boolean {
  if (specifier.startsWith("node:")) return true;
  const bare = specifier.split("/")[0] ?? "";
  return [
    "fs", "path", "os", "child_process", "crypto", "net", "http", "https",
    "stream", "util", "url", "zlib", "worker_threads", "process", "module",
  ].includes(bare);
}

/**
 * Collects every relative import, separating value imports from type-only ones.
 * `import type` is erased at compile time, so it cannot drag a module into the
 * renderer bundle and is not a violation.
 */
function readImports(source: string): { value: string[]; type: string[] } {
  const value: string[] = [];
  const type: string[] = [];
  // Matches `import ... from "x"`, `export ... from "x"` and bare `import "x"`.
  const pattern = /(?:^|\n)\s*(?:import|export)(\s+type)?\s+(?:[^'"]*?\sfrom\s+)?["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) {
    const isTypeOnly = Boolean(match[1]);
    const specifier = match[2] ?? "";
    (isTypeOnly ? type : value).push(specifier);
  }
  return { value, type };
}

async function resolveLocal(fromFile: string, specifier: string): Promise<string | undefined> {
  if (!specifier.startsWith(".")) return undefined;
  // Sources import with a .js extension that maps back to the .ts file.
  const candidate = resolve(dirname(fromFile), specifier.replace(/\.js$/, ".ts"));
  try {
    await readFile(candidate, "utf8");
    return candidate;
  } catch {
    return undefined;
  }
}

test("the renderer's module graph never reaches a Node built-in", async () => {
  const visited = new Set<string>();
  const violations: string[] = [];
  const queue: Array<{ file: string; via: string[] }> = [{ file: ENTRY, via: [] }];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current.file)) continue;
    visited.add(current.file);

    const source = await readFile(current.file, "utf8");
    const { value } = readImports(source);
    const relative = current.file.replace(/.*\/src\//, "src/");

    for (const specifier of value) {
      if (isNodeBuiltin(specifier)) {
        violations.push(`${[...current.via, relative].join(" -> ")} imports ${specifier}`);
        continue;
      }
      const next = await resolveLocal(current.file, specifier);
      if (next) queue.push({ file: next, via: [...current.via, relative] });
    }
  }

  assert.ok(visited.size > 5, `expected to walk a real graph, only saw ${visited.size} files`);
  assert.deepEqual(
    violations,
    [],
    `the sandboxed renderer cannot load Node built-ins:\n  ${violations.join("\n  ")}`,
  );
});

test("the indexing service itself stays out of the renderer's reach", async () => {
  // The service spawns a process, so it must never become reachable; the status
  // shape it publishes lives in domain/indexing.ts precisely so it need not be.
  const service = await readFile(resolve(import.meta.dirname, "../../src/indexing/index-service.ts"), "utf8");
  assert.match(service, /from "node:child_process"/, "the service is the module that owns process spawning");

  const state = await readFile(resolve(import.meta.dirname, "../../src/kernel/state.ts"), "utf8");
  assert.doesNotMatch(
    state,
    /indexing\/index-service/,
    "KernelState is imported by the renderer, so it must take the status shape from domain/",
  );
  assert.match(state, /domain\/indexing\.js/);
});
