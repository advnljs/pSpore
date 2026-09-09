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
  const smokeHarness = await readFile(new URL("../../scripts/electron-smoke.mjs", import.meta.url), "utf8");

  assert.match(workflow, /runs-on: ubuntu-24\.04-arm/);
  assert.match(workflow, /image: ubuntu:20\.04/);
  // In a container the runner picks `sh`, not bash. Both the version guard and
  // the release upload in this job are written in bash, and under dash one
  // failed open while the other aborted the release.
  assert.match(workflow, /defaults:\n      run:\n        shell: bash/);
  assert.match(workflow, /getconf GNU_LIBC_VERSION\)" = "glibc 2\.31"/);
  assert.match(workflow, /node node_modules\/electron\/install\.js/);
  assert.match(workflow, /PSPORE_ELECTRON_NO_SANDBOX=1/);
  assert.match(workflow, /PSPORE_ELECTRON_SMOKE_TIMEOUT_MS=180000/);
  assert.match(workflow, /XDG_CACHE_HOME=\/home\/pspore-builder\/\.cache/);
  assert.match(workflow, /dbus-run-session -- npm run test:electron/);
  assert.match(workflow, /npm run test:electron/);
  assert.match(workflow, /scripts\/package-desktop\.sh "\$VERSION" arm64/);
  assert.match(workflow, /actions\/upload-artifact@v\d+/);
  // A preview build must never touch a release. It may upload assets, but only
  // when the release workflow hands it a tag, and it never creates one itself.
  assert.doesNotMatch(workflow, /gh release create/);
  assert.match(workflow, /if: inputs\.release_tag != ''\n(?:.*\n)*?.*gh release upload/);
  assert.match(smokeHarness, /PSPORE_ELECTRON_NO_SANDBOX/);
  assert.match(smokeHarness, /PSPORE_ELECTRON_SMOKE_TIMEOUT_MS/);
  assert.match(smokeHarness, /"--no-sandbox"/);
  assert.match(smokeHarness, /"--disable-dev-shm-usage"/);
  assert.match(smokeHarness, /external output:/);
});

test("release publishes a draft only after both architectures verify, without build artifacts", async () => {
  const workflow = await readFile(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");
  const arm = await readFile(new URL("../../.github/workflows/package-arm64.yml", import.meta.url), "utf8");

  assert.match(workflow, /uses: \.\/\.github\/workflows\/package-arm64\.yml/);
  assert.match(workflow, /expected_version: \$\{\{ needs\.validate-release\.outputs\.version \}\}/);
  // Assets go straight onto a draft. Actions storage is a metered 500 MB, and
  // routing a release of this size through it filled the quota and then failed
  // every later release until the artifacts were purged by hand.
  assert.doesNotMatch(workflow, /upload-artifact|download-artifact|release-assets-/);
  assert.match(workflow, /gh release create "\$\{GITHUB_REF_NAME\}" --draft/);
  assert.match(workflow, /gh release upload "\$\{GITHUB_REF_NAME\}"/);
  assert.match(arm, /gh release upload "\$TAG"/);
  assert.match(arm, /if: inputs\.release_tag != ''/);
  // The preview path still uses an artifact; only the release path changed. That
  // upload is non-fatal on purpose: a full artifact store once failed an ARM64
  // run whose build and smoke had both passed, and that failure blocked the
  // release waiting on it.
  assert.match(
    arm,
    /if: inputs\.release_tag == ''\n        continue-on-error: true\n        uses: actions\/upload-artifact/,
  );

  assert.match(workflow, /pspore-desktop-\$\{VERSION\}-linux-\$\{ARCH\}-overlay\.zip/);
  assert.match(workflow, /x86_64 - Full desktop package/);
  // Each architecture labels its own assets at upload time, because `gh release
  // edit` cannot attach labels and re-uploading 800 MB just to add them would
  // put the traffic back that this change removed.
  assert.match(arm, /ARM64 \/ Kylin V10 - Full desktop package/);
  assert.match(workflow, /### ARM64 \/ Kylin V10/);
  assert.match(workflow, /### x86_64/);
  // Nothing is visible until every checksum has been checked against the bytes
  // that will publish, which is what undrafting then makes public.
  assert.match(workflow, /needs:[\s\S]*package-x64[\s\S]*package-arm64[\s\S]*sha256sum --check[\s\S]*gh release edit "\$TAG"[\s\S]*--draft=false/);
});
