import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { BUNDLED_MARKER } from "../../src/plugins/bundled-skills.js";
import { deriveSkillDescription, scanWorkspaceSkills } from "../../src/plugins/workspace-skills.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

async function skillsRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pspore-workspace-skills-"));
  roots.push(root);
  return root;
}

async function write(path: string, content: string | Uint8Array): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
}

test("a skill suite the user copied in is loaded from its SKILL.md, not its sub-documents", async () => {
  const root = await skillsRoot();
  await write(join(root, "ccb-mail", "SKILL.md"), [
    "---",
    "name: ccb-mail",
    "description: 邮件技能套件：收取待办、发送、读取、列出邮件与通讯录。",
    "---",
    "",
    "# ccb-mail",
    "按任务打开 SKILL_SENDMAIL.md 等子文档。",
  ].join("\n"));
  await write(join(root, "ccb-mail", "SKILL_SENDMAIL.md"), "---\nname: send\ndescription: send mail\n---\n");
  await write(join(root, "ccb-mail", "SKILL_SETUP.md"), "# setup\n");

  const scan = await scanWorkspaceSkills(root);
  assert.deepEqual(scan.skills, [{
    name: "ccb-mail",
    description: "邮件技能套件：收取待办、发送、读取、列出邮件与通讯录。",
    filePath: join(root, "ccb-mail", "SKILL.md"),
    baseDir: join(root, "ccb-mail"),
    disableModelInvocation: false,
  }]);
  assert.deepEqual(scan.catalog.map((entry) => [entry.name, entry.source, entry.status]), [["ccb-mail", "workspace", "active"]]);
  assert.equal(scan.catalog[0]?.message, undefined);
});

test("frontmatter Pi would reject as YAML, or leave without a description, still yields a skill and says what was assumed", async () => {
  const root = await skillsRoot();
  // An unquoted second colon is invalid YAML; Pi's loader drops such a skill silently.
  await write(join(root, "mail", "SKILL.md"), "---\nname: mail\ndescription: 发送邮件: 支持附件与抄送\n---\n\nBody\n");
  await write(join(root, "report", "SKILL.md"), [
    "# 周报助手",
    "",
    "```bash",
    "not a description",
    "```",
    "",
    "根据本周的**会议纪要**生成周报，",
    "并发给部门负责人。",
    "",
    "## 步骤",
  ].join("\n"));
  await write(join(root, "empty", "SKILL.md"), "---\nname: empty\n---\n\n```\ncode only\n```\n");

  const scan = await scanWorkspaceSkills(root);
  const byName = new Map(scan.catalog.map((entry) => [entry.name, entry]));

  assert.equal(byName.get("mail")?.status, "active");
  assert.equal(byName.get("mail")?.description, "发送邮件: 支持附件与抄送");
  assert.match(byName.get("mail")?.message ?? "", /not valid YAML/);

  // No frontmatter at all: the directory names it, the opening text describes it.
  assert.equal(byName.get("report")?.status, "active");
  assert.equal(byName.get("report")?.description, "周报助手 — 根据本周的会议纪要生成周报，并发给部门负责人。");
  assert.match(byName.get("report")?.message ?? "", /opening text/);

  assert.equal(byName.get("empty")?.status, "skipped");
  assert.match(byName.get("empty")?.message ?? "", /no description/);
  assert.deepEqual(scan.skills.map((skill) => skill.name), ["mail", "report"]);
});

test("entries that are not loadable are listed with a reason instead of vanishing", async () => {
  const root = await skillsRoot();
  await write(join(root, "lowercase", "skill.md"), "---\ndescription: wrong file name\n---\n");
  await write(join(root, "parts-only", "SKILL_SENDMAIL.md"), "# send\n");
  await write(join(root, "gbk", "SKILL.md"), Uint8Array.from([0x2d, 0x2d, 0x2d, 0x0a, 0xd3, 0xca, 0xbc, 0xfe, 0x0a]));
  await write(join(root, "huge", "SKILL.md"), `---\ndescription: big\n---\n${"x".repeat(300 * 1024)}`);
  await symlink(join(root, "missing-target"), join(root, "dangling"));

  const scan = await scanWorkspaceSkills(root);
  assert.deepEqual(scan.skills, []);
  const reasons = Object.fromEntries(scan.catalog.map((entry) => [entry.name, `${entry.status}: ${entry.message ?? ""}`]));
  assert.match(reasons["lowercase"] ?? "", /^skipped: skill\.md must be named exactly SKILL\.md/);
  assert.match(reasons["parts-only"] ?? "", /^skipped: no SKILL\.md found \(has SKILL_SENDMAIL\.md\)/);
  assert.match(reasons["gbk"] ?? "", /^skipped: is not UTF-8 text/);
  assert.match(reasons["huge"] ?? "", /^skipped: is larger than 256 KiB/);
  assert.match(reasons["dangling"] ?? "", /^skipped: symbolic link target does not exist/);
});

test("nested suites, root-level skill files, and pSpore's own entries follow the same rules as Pi", async () => {
  const root = await skillsRoot();
  await write(join(root, "office", "excel", "SKILL.md"), "---\ndescription: Excel helpers\n---\n");
  await write(join(root, "office", "word", "SKILL.md"), "---\ndescription: Word helpers\n---\n");
  await write(join(root, "quick-note.md"), "---\ndescription: Take a quick note\n---\n");
  // A root README is documentation, not a skill, and is not reported as a broken one.
  await write(join(root, "README.md"), "# My skills\n\nNotes about this folder.\n");
  await write(join(root, ".installed", "trusted", "abc", "SKILL.md"), "---\ndescription: installed copy\n---\n");
  await write(join(root, "aegis-search", "SKILL.md"), "---\ndescription: bundled link\n---\n");
  await write(join(root, "old-bundled", "SKILL.md"), "---\ndescription: left by an older release\n---\n");
  await writeFile(join(root, "old-bundled", BUNDLED_MARKER), JSON.stringify({ version: "0.1.0" }));
  await symlink(join(root, "office"), join(root, "office-link"));

  const scan = await scanWorkspaceSkills(root, { managedNames: new Set(["aegis-search"]) });
  assert.deepEqual(scan.skills.map((skill) => [skill.name, skill.description]), [
    ["excel", "Excel helpers"],
    ["word", "Word helpers"],
    ["quick-note", "Take a quick note"],
  ]);
  assert.deepEqual(scan.catalog.map((entry) => entry.name), ["excel", "quick-note", "word"]);
});

test("a workspace skill never replaces a bundled or installed skill of the same name, nor an earlier workspace one", async () => {
  const root = await skillsRoot();
  await write(join(root, "a-copy", "SKILL.md"), "---\nname: doc-extract\ndescription: my own doc-extract\n---\n");
  await write(join(root, "b-mail", "SKILL.md"), "---\nname: mail\ndescription: first mail skill\n---\n");
  await write(join(root, "c-mail", "SKILL.md"), "---\nname: mail\ndescription: second mail skill\n---\n");
  await write(join(root, "d-hidden", "SKILL.md"), "---\ndescription: manual only\ndisable-model-invocation: true\n---\n");

  const scan = await scanWorkspaceSkills(root, { reservedNames: new Map([["doc-extract", "bundled"]]) });
  assert.deepEqual(scan.skills.map((skill) => [skill.name, skill.filePath, skill.disableModelInvocation]), [
    ["mail", join(root, "b-mail", "SKILL.md"), false],
    ["d-hidden", join(root, "d-hidden", "SKILL.md"), true],
  ]);
  const shadowed = scan.catalog.filter((entry) => entry.status === "shadowed");
  assert.deepEqual(shadowed.map((entry) => entry.path), [join(root, "a-copy", "SKILL.md"), join(root, "c-mail", "SKILL.md")]);
  assert.match(shadowed[0]?.message ?? "", /bundled skill named doc-extract takes precedence/);
  assert.match(shadowed[1]?.message ?? "", /b-mail.*already uses the name mail/);
});

test("a missing skills directory is simply empty", async () => {
  const root = await skillsRoot();
  assert.deepEqual(await scanWorkspaceSkills(join(root, "absent")), { skills: [], catalog: [] });
});

test("a description derived from the body is bounded", () => {
  assert.equal(deriveSkillDescription(""), "");
  assert.equal(deriveSkillDescription("# Only a title"), "Only a title");
  assert.equal(deriveSkillDescription("- 列表第一项\n- 第二项"), "列表第一项；第二项");
  assert.equal(deriveSkillDescription("Sends mail\nthrough SMTP.\n\nMore."), "Sends mail through SMTP.");
  assert.equal(deriveSkillDescription("- one\n- two"), "one; two");
  const long = deriveSkillDescription("x".repeat(1_000));
  assert.equal(long.length, 280);
  assert.ok(long.endsWith("…"));
});
