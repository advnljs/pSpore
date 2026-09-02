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

test("release validates the remote annotated tag instead of checkout's peeled ref", async () => {
  const workflow = await readFile(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");
  assert.match(workflow, /git ls-remote --tags origin "\$TAG_REF"/);
  assert.match(workflow, /git ls-remote --tags origin "\$\{TAG_REF\}\^\{\}"/);
  assert.match(workflow, /REMOTE_PEELED_COMMIT.*GITHUB_SHA/);
  assert.doesNotMatch(workflow, /git cat-file -t "refs\/tags\/\$\{GITHUB_REF_NAME\}"/);
});

test("ARM packaging runs natively against a glibc 2.31 baseline without touching Releases", async () => {
  const workflow = await readFile(new URL("../../.github/workflows/package-arm64.yml", import.meta.url), "utf8");

  assert.match(workflow, /runs-on: ubuntu-24\.04-arm/);
  assert.match(workflow, /image: ubuntu:20\.04/);
  assert.match(workflow, /getconf GNU_LIBC_VERSION\)" = "glibc 2\.31"/);
  assert.match(workflow, /npm run test:electron/);
  assert.match(workflow, /scripts\/package-desktop\.sh "\$VERSION" arm64/);
  assert.match(workflow, /actions\/upload-artifact@v\d+/);
  assert.doesNotMatch(workflow, /gh release (?:create|upload)/);
});
