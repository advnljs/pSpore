import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import { ExtensionManager, readResourceTrustSummary } from "../../src/plugins/extension-manager.js";
import type { HostPluginActivationConfig } from "../../src/plugins/types.js";

const roots: string[] = [];
const managers: ExtensionManager[] = [];

afterEach(async () => {
  await Promise.allSettled(managers.splice(0).map(async (manager) => manager.stop("test cleanup")));
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

describe("trusted staged resources", () => {
  test("inspects but does not activate a skill until exact-digest install, then revokes at a session boundary", async () => {
    const fixture = await createFixture();
    const skill = join(fixture.staging, "review-skill");
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, "SKILL.md"), [
      "---",
      "name: review-skill",
      "description: Reviews a bounded change when the user asks for a code review.",
      "---",
      "",
      "# Review workflow",
      "",
      "Read the target diff only when this skill is selected.",
      "",
    ].join("\n"));
    const manager = await managerFor(fixture);

    const inspected = await manager.inspect("review-skill");
    assert.equal(inspected.kind, "skill");
    assert.equal(inspected.name, "review-skill");
    assert.equal(inspected.installable, true);
    assert.deepEqual(await manager.skillPaths(), []);
    await assert.rejects(manager.install("review-skill", "0".repeat(64)), /changed/);

    const installed = await manager.install("review-skill", inspected.digest);
    assert.equal(installed.record.trusted, true);
    assert.equal(installed.health.status, "active");
    assert.equal((await stat(installed.installPath)).mode & 0o777, 0o700);
    assert.equal((await stat(join(installed.installPath, "SKILL.md"))).mode & 0o777, 0o600);
    assert.deepEqual(await manager.skillPaths(), [installed.installPath]);
    assert.deepEqual(await readResourceTrustSummary(fixture.trustPath), {
      trusted: 1,
      disabled: 0,
      skills: 1,
      hostPlugins: 0,
    });
    assert.equal((await stat(fixture.trustPath)).mode & 0o777, 0o600);

    await writeFile(join(skill, "SKILL.md"), "changed after inspection\n");
    assert.match(await readFile(join(installed.installPath, "SKILL.md"), "utf8"), /Review workflow/);
    const disabled = await manager.disable("skill", "review-skill", inspected.digest);
    assert.equal(disabled.health.status, "disabled");
    assert.deepEqual(await manager.skillPaths(), []);
  });

  test("rejects staging escape, symlinks, and tampered installed content", async () => {
    const fixture = await createFixture();
    const outside = join(fixture.root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "SKILL.md"), skillText("outside-skill"));
    const manager = await managerFor(fixture);
    await assert.rejects(manager.inspect(outside), /escapes workspace\/staging/);

    const linked = join(fixture.staging, "linked-skill");
    await mkdir(linked);
    await writeFile(join(linked, "SKILL.md"), skillText("linked-skill"));
    await symlink(join(outside, "SKILL.md"), join(linked, "reference.md"));
    await assert.rejects(manager.inspect("linked-skill"), /symbolic links/);

    const safe = join(fixture.staging, "safe-skill");
    await mkdir(safe);
    await writeFile(join(safe, "SKILL.md"), skillText("safe-skill"));
    const inspected = await manager.inspect("safe-skill");
    const installed = await manager.install("safe-skill", inspected.digest);
    await writeFile(join(installed.installPath, "SKILL.md"), skillText("tampered-skill"));
    assert.deepEqual(await manager.skillPaths(), []);
    assert.equal(manager.list()[0]?.health.status, "blocked");
  });

  test("never executes staged host code and starts only an exact trusted digest with exact capability grants", async () => {
    const fixture = await createFixture();
    const marker = join(fixture.root, "plugin-marker.log");
    const plugin = join(fixture.staging, "fixture-plugin");
    await mkdir(plugin, { recursive: true });
    await writeFile(join(plugin, "pspore.plugin.json"), `${JSON.stringify({
      apiVersion: 1,
      name: "fixture-plugin",
      version: "1.0.0",
      entry: "index.mjs",
      capabilities: ["network.http"],
      contributes: ["transport"],
    }, null, 2)}\n`);
    await writeFile(join(plugin, "index.mjs"), [
      'import { appendFile } from "node:fs/promises";',
      `const marker = ${JSON.stringify(marker)};`,
      "export default {",
      "  async start(context) { await appendFile(marker, `start:${context.name}:${context.capabilities.join(',')}\\n`); },",
      "  health() { return { status: 'ready', message: 'fixture healthy' }; },",
      "  async stop(reason) { await appendFile(marker, `stop:${reason}\\n`); },",
      "};",
      "",
    ].join("\n"));

    const installer = await managerFor(fixture);
    const inspected = await installer.inspect("fixture-plugin");
    assert.equal(inspected.kind, "host-plugin");
    assert.deepEqual(inspected.capabilities, ["network.http"]);
    assert.deepEqual(inspected.contributes, ["transport"]);
    await assert.rejects(access(marker));
    const installed = await installer.install("fixture-plugin", inspected.digest);
    assert.equal(installed.health.status, "installed");
    await assert.rejects(access(marker));
    await installer.stop("restart for activation");

    const blockedErrors: Error[] = [];
    const blocked = await managerFor(fixture, [{
      name: "fixture-plugin",
      enabled: true,
      digest: inspected.digest,
      grantedCapabilities: [],
    }], blockedErrors);
    await blocked.startHostPlugins();
    assert.equal(blocked.list()[0]?.health.status, "blocked");
    assert.match(blockedErrors[0]?.message ?? "", /Capability grant/);
    await assert.rejects(access(marker));
    await blocked.stop("blocked restart");

    const active = await managerFor(fixture, [{
      name: "fixture-plugin",
      enabled: true,
      digest: inspected.digest,
      grantedCapabilities: ["network.http"],
    }]);
    await active.startHostPlugins();
    assert.equal(active.list()[0]?.health.status, "ready");
    assert.match(await readFile(marker, "utf8"), /start:fixture-plugin:network.http/);
    await active.stop("verified shutdown");
    assert.match(await readFile(marker, "utf8"), /stop:verified shutdown/);
  });
});

interface Fixture {
  root: string;
  staging: string;
  skills: string;
  plugins: string;
  trustPath: string;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pspore-resources-"));
  roots.push(root);
  return {
    root,
    staging: join(root, "workspace", "staging"),
    skills: join(root, "workspace", "skills"),
    plugins: join(root, "plugins"),
    trustPath: join(root, "state", "resource-trust.json"),
  };
}

async function managerFor(
  fixture: Fixture,
  activations: readonly HostPluginActivationConfig[] = [],
  errors: Error[] = [],
): Promise<ExtensionManager> {
  const manager = await ExtensionManager.create({
    stagingRoot: fixture.staging,
    skillsRoot: fixture.skills,
    pluginsRoot: fixture.plugins,
    trustPath: fixture.trustPath,
    activations,
    clock: () => new Date("2026-08-10T01:30:00.000Z"),
    onError: (error) => errors.push(error),
  });
  managers.push(manager);
  return manager;
}

function skillText(name: string): string {
  return `---\nname: ${name}\ndescription: A bounded test skill for trust validation.\n---\n\n# ${name}\n`;
}
