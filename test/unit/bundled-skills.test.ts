import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BUNDLED_MARKER,
  bundledSkillsRoots,
  compareVersions,
  linkBundledSkills,
  readBundledSkills,
  resolveBundledSkillsRoot,
} from "../../src/plugins/bundled-skills.js";

async function writeSkill(root: string, name: string, version: string, extra = ""): Promise<string> {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: "${name} bundled skill"\nversion: ${version}\n---\n\n# ${name}\n${extra}`,
  );
  return directory;
}

test("bundled skills are read from the release payload with name, version and description", async () => {
  const root = await mkdtemp(join(tmpdir(), "pspore-bundled-read-"));
  try {
    await writeSkill(root, "aegis-search", "0.2.0");
    // A directory with no SKILL.md is not a skill and must be ignored.
    await mkdir(join(root, "not-a-skill"), { recursive: true });
    // An unparsable version is rejected rather than silently treated as 0.0.0.
    await mkdir(join(root, "bad-version"), { recursive: true });
    await writeFile(join(root, "bad-version", "SKILL.md"), "---\nname: bad-version\nversion: latest\n---\n");

    const skills = await readBundledSkills(root);
    assert.equal(skills.length, 1);
    assert.equal(skills[0]?.name, "aegis-search");
    assert.equal(skills[0]?.version, "0.2.0");
    assert.equal(skills[0]?.description, "aegis-search bundled skill");

    // A build that ships no bundled skills is legitimate.
    assert.deepEqual(await readBundledSkills(join(root, "missing")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("startup links a bundled skill into the workspace and is idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "pspore-bundled-link-"));
  try {
    const release = join(root, "release");
    const skills = join(root, "workspace", "skills");
    const source = await writeSkill(release, "aegis-search", "0.2.0");

    const first = await linkBundledSkills(await readBundledSkills(release), skills);
    assert.equal(first[0]?.action, "linked");
    const target = join(skills, "aegis-search");
    assert.equal((await lstat(target)).isSymbolicLink(), true);
    assert.equal(await readlink(target), source);
    // The skill is reachable through the workspace path Pi is handed.
    assert.match(await readFile(join(target, "SKILL.md"), "utf8"), /aegis-search bundled skill/);

    // A second startup must not churn the link.
    const second = await linkBundledSkills(await readBundledSkills(release), skills);
    assert.equal(second[0]?.action, "current");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a link left by a previous install directory is repointed at the current release", async () => {
  const root = await mkdtemp(join(tmpdir(), "pspore-bundled-relink-"));
  try {
    const oldRelease = join(root, "old-release");
    const newRelease = join(root, "new-release");
    const skills = join(root, "workspace", "skills");
    await writeSkill(oldRelease, "aegis-search", "0.2.0");
    const newSource = await writeSkill(newRelease, "aegis-search", "0.2.0");

    await linkBundledSkills(await readBundledSkills(oldRelease), skills);
    // The old install goes away, exactly as it would after moving the app.
    await rm(oldRelease, { recursive: true, force: true });

    const results = await linkBundledSkills(await readBundledSkills(newRelease), skills);
    assert.equal(results[0]?.action, "relinked");
    assert.equal(await readlink(join(skills, "aegis-search")), newSource);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a materialized bundled copy is replaced only by a newer release version", async () => {
  const root = await mkdtemp(join(tmpdir(), "pspore-bundled-upgrade-"));
  try {
    const release = join(root, "release");
    const skills = join(root, "workspace", "skills");
    // Simulate what an older pSpore left behind: a real directory plus a marker.
    const existing = join(skills, "aegis-search");
    await mkdir(existing, { recursive: true });
    await writeFile(join(existing, "SKILL.md"), "---\nname: aegis-search\n---\nold copy\n");
    await writeFile(join(existing, BUNDLED_MARKER), JSON.stringify({ version: "0.2.0" }));

    // Same version: the working copy is left alone.
    await writeSkill(release, "aegis-search", "0.2.0");
    const same = await linkBundledSkills(await readBundledSkills(release), skills);
    assert.equal(same[0]?.action, "current");
    assert.equal(same[0]?.previousVersion, "0.2.0");
    assert.equal((await lstat(existing)).isDirectory(), true);
    assert.equal((await lstat(existing)).isSymbolicLink(), false);

    // Newer version: replaced with a link to the release copy.
    await rm(join(release, "aegis-search"), { recursive: true, force: true });
    const newer = await writeSkill(release, "aegis-search", "0.3.0");
    const upgraded = await linkBundledSkills(await readBundledSkills(release), skills);
    assert.equal(upgraded[0]?.action, "upgraded");
    assert.equal(upgraded[0]?.previousVersion, "0.2.0");
    assert.equal(await readlink(existing), newer);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a skill directory the user wrote is never overwritten", async () => {
  const root = await mkdtemp(join(tmpdir(), "pspore-bundled-user-"));
  try {
    const release = join(root, "release");
    const skills = join(root, "workspace", "skills");
    await writeSkill(release, "aegis-search", "9.9.9");

    // No bundled marker: this is the user's own work.
    const mine = join(skills, "aegis-search");
    await mkdir(mine, { recursive: true });
    await writeFile(join(mine, "SKILL.md"), "---\nname: aegis-search\n---\nmy own skill\n");

    const results = await linkBundledSkills(await readBundledSkills(release), skills);
    assert.equal(results[0]?.action, "kept-user-copy");
    assert.match(results[0]?.message ?? "", /was not created by pSpore/);
    assert.equal(await readFile(join(mine, "SKILL.md"), "utf8"), "---\nname: aegis-search\n---\nmy own skill\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a broken link is reported without aborting the remaining skills", async () => {
  const root = await mkdtemp(join(tmpdir(), "pspore-bundled-failure-"));
  try {
    const release = join(root, "release");
    const skills = join(root, "workspace", "skills");
    await writeSkill(release, "alpha-skill", "1.0.0");
    await writeSkill(release, "beta-skill", "1.0.0");
    await mkdir(skills, { recursive: true });
    // A path that cannot be replaced by a directory link: a symlink loop target
    // is fine, so instead make the parent unwritable via a file collision.
    await writeFile(join(skills, "alpha-skill"), "not a directory");

    const results = await linkBundledSkills(await readBundledSkills(release), skills);
    const alpha = results.find((entry) => entry.name === "alpha-skill");
    const beta = results.find((entry) => entry.name === "beta-skill");
    // A plain file is indistinguishable from user content, so it is preserved.
    assert.equal(alpha?.action, "kept-user-copy");
    assert.equal(beta?.action, "linked");
    assert.equal(await readFile(join(skills, "alpha-skill"), "utf8"), "not a directory");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("version comparison orders releases and prereleases correctly", () => {
  assert.equal(compareVersions("0.2.0", "0.1.9"), 1);
  assert.equal(compareVersions("0.2.0", "0.2.0"), 0);
  assert.equal(compareVersions("0.2.0", "0.10.0"), -1);
  assert.equal(compareVersions("1.0.0", "0.99.99"), 1);
  // A prerelease precedes its own release.
  assert.equal(compareVersions("1.0.0-rc.1", "1.0.0"), -1);
  assert.equal(compareVersions("1.0.0", "1.0.0-rc.1"), 1);
  assert.equal(compareVersions("1.0.0-rc.1", "1.0.0-rc.2"), -1);
});

test("the bundled root is found in dist, in the source tree, and outside an asar", () => {
  // Packaged npm/dist layout: dist/plugins/bundled-skills.js -> dist/bundled-skills
  const dist = bundledSkillsRoots("file:///app/dist/plugins/bundled-skills.js");
  assert.equal(dist[0], "/app/dist/bundled-skills");
  assert.equal(dist[1], "/app/bundled-skills");

  // Electron: the archive holds no real files, so the unpacked copy must win.
  const asar = bundledSkillsRoots("file:///opt/pspore/resources/app.asar/dist/plugins/bundled-skills.js");
  assert.equal(asar[0], "/opt/pspore/resources/app.asar.unpacked/dist/bundled-skills");
  assert.ok(asar.includes("/opt/pspore/resources/app.asar/dist/bundled-skills"));
  assert.ok(
    asar.indexOf("/opt/pspore/resources/app.asar.unpacked/dist/bundled-skills")
      < asar.indexOf("/opt/pspore/resources/app.asar/dist/bundled-skills"),
    "the unpacked path must be preferred over the in-archive path",
  );
});

test("the repository's own bundled skills resolve and parse", async () => {
  const root = await resolveBundledSkillsRoot();
  assert.ok(root, "the repository ships bundled skills");
  const skills = await readBundledSkills(root as string);
  const aegis = skills.find((skill) => skill.name === "aegis-search");
  assert.ok(aegis, "aegis-search is bundled");
  assert.match(aegis?.version ?? "", /^\d+\.\d+\.\d+$/);
  assert.ok((aegis?.description ?? "").length > 40, "the description tells the model when to use it");
});
