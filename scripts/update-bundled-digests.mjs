// Records the real SHA-256 of each bundled-skill binary asset from its upstream
// release into bundled-skills/binaries.json.
//
// The manifest ships with placeholder digests so a fetch fails loudly rather
// than installing an unverified binary; this fills them in once the upstream
// release exists.
//
// Usage: node scripts/update-bundled-digests.mjs [--version X.Y.Z]
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const manifestPath = join(root, "bundled-skills", "binaries.json");
const versionFlag = process.argv.indexOf("--version");
const override = versionFlag >= 0 ? process.argv[versionFlag + 1] : undefined;

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const work = await mkdtemp(join(tmpdir(), "pspore-digests-"));

try {
  for (const skill of manifest.skills) {
    if (override) skill.version = override;
    for (const [arch, target] of Object.entries(skill.architectures)) {
      const tag = `v${skill.version}`;
      // The asset name embeds the version, so deriving it here is what keeps a
      // version bump from pointing at the previous release's file.
      const asset = skill.assetTemplate
        .replace("{version}", skill.version)
        .replace("{releaseArch}", target.releaseArch);
      process.stdout.write(`==> ${skill.name} ${tag} ${arch}: ${asset}\n`);
      await run("gh", [
        "release", "download", tag,
        "--repo", skill.repository,
        "--pattern", asset,
        "--dir", work,
        "--clobber",
      ], { maxBuffer: 64 * 1024 * 1024 });
      const digest = createHash("sha256").update(await readFile(join(work, asset))).digest("hex");
      if (target.sha256 === digest) {
        process.stdout.write(`    unchanged ${digest}\n`);
      } else {
        process.stdout.write(`    ${target.sha256.startsWith("0000") ? "recorded" : "updated"} ${digest}\n`);
        target.sha256 = digest;
      }
    }
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write("==> bundled-skills/binaries.json updated\n");
} finally {
  await rm(work, { recursive: true, force: true });
}
