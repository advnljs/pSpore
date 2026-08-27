import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PSPORE_VERSION } from "../../src/version.js";

test("release version stays aligned across source and package manifests", async () => {
  const packageManifest = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as {
    version?: unknown;
  };
  const lockManifest = JSON.parse(await readFile(new URL("../../package-lock.json", import.meta.url), "utf8")) as {
    version?: unknown;
    packages?: Record<string, { version?: unknown }>;
  };

  assert.equal(packageManifest.version, PSPORE_VERSION);
  assert.equal(lockManifest.version, PSPORE_VERSION);
  assert.equal(lockManifest.packages?.[""]?.version, PSPORE_VERSION);
});

test("release checkout preserves annotated tag objects", async () => {
  const workflow = await readFile(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");
  assert.match(workflow, /uses: actions\/checkout@v4\n\s+with:\n(?:\s+#.*\n)*\s+fetch-depth: 0\n\s+fetch-tags: true/);
});
