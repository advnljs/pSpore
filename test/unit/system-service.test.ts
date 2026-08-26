import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { serviceLaunchSpec } from "../../src/service/service-launch.js";
import {
  renderSystemdUserUnit,
  serviceUnitName,
  SystemServiceManager,
  systemdQuote,
  type SystemServiceCommandResult,
} from "../../src/service/system-service.js";

test("renders a restartable private user service without invoking a shell", () => {
  const unit = renderSystemdUserUnit("/home/user/.pspore", {
    executable: "/opt/pSpore 100%/pspore-desktop",
    args: ["/opt/pSpore/resources/app.asar/dist/cli/main.js", "--home", "/home/user/.pspore", "daemon"],
    workingDirectory: "/home/user/.pspore/workspace",
    environment: { ELECTRON_RUN_AS_NODE: "1" },
  });
  assert.match(unit, /ExecStart="\/opt\/pSpore 100%%\/pspore-desktop"/);
  assert.match(unit, /Environment="ELECTRON_RUN_AS_NODE=1"/);
  assert.match(unit, /Environment="PSPORE_HOME=\/home\/user\/\.pspore"/);
  assert.match(unit, /Restart=always/);
  assert.match(unit, /WantedBy=default\.target/);
  assert.doesNotMatch(unit, /sh -c/);
  assert.equal(systemdQuote('a "quoted" path'), '"a \\"quoted\\" path"');
  assert.throws(() => systemdQuote("bad\nargument"), /newlines/);
});

test("installs, enables, restarts and removes an isolated systemd user unit", async () => {
  const root = await mkdtemp(join(tmpdir(), "pspore-system-service-"));
  const config = join(root, "config");
  const home = join(root, "home");
  const workspace = join(home, "workspace");
  await mkdir(workspace, { recursive: true });
  let active = false;
  let enabled = false;
  let linger = false;
  let beforeStarts = 0;
  const calls: string[][] = [];
  const runner = async (executable: string, args: readonly string[]): Promise<SystemServiceCommandResult> => {
    calls.push([executable, ...args]);
    if (executable === "systemctl" && args.includes("is-active")) {
      return result(active ? 0 : 3, active ? "active\n" : "inactive\n");
    }
    if (executable === "systemctl" && args.includes("is-enabled")) {
      return result(enabled ? 0 : 1, enabled ? "enabled\n" : "disabled\n");
    }
    if (executable === "systemctl" && args.includes("enable")) {
      active = true;
      enabled = true;
    }
    if (executable === "systemctl" && args.includes("restart")) active = true;
    if (executable === "systemctl" && args.includes("stop")) active = false;
    if (executable === "systemctl" && args.includes("disable")) {
      active = false;
      enabled = false;
    }
    if (executable === "loginctl" && args.includes("enable-linger")) linger = true;
    if (executable === "loginctl" && args.includes("show-user")) return result(0, linger ? "yes\n" : "no\n");
    return result(0);
  };
  const manager = new SystemServiceManager({
    home,
    userConfigDirectory: config,
    username: "fixture-user",
    runner,
    beforeStart: async () => { beforeStarts += 1; },
  });
  const spec = { executable: "/usr/bin/node", args: ["/opt/pspore/main.js", "daemon"], workingDirectory: workspace };
  try {
    const first = await manager.ensureRunning(spec);
    assert.equal(first.unitChanged, true);
    assert.equal(first.active, true);
    assert.equal(first.enabled, true);
    assert.equal(first.linger, true);
    assert.equal(beforeStarts, 1);
    assert.match(await readFile(manager.unitPath, "utf8"), /\/opt\/pspore\/main\.js/);

    const second = await manager.ensureRunning(spec);
    assert.equal(second.unitChanged, false);
    assert.equal(beforeStarts, 1);
    assert.ok(calls.some((call) => call.join(" ").includes("systemctl --user enable --now")));

    await manager.restart();
    await manager.stop();
    assert.equal((await manager.status()).active, false);
    await manager.uninstall();
    assert.equal((await manager.status()).installed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("builds Node SEA and Electron-as-Node service launch commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "pspore-service-launch-"));
  const desktopEntry = join(root, "dist", "desktop", "main.js");
  const cliEntry = join(root, "dist", "cli", "main.js");
  await mkdir(join(root, "dist", "desktop"), { recursive: true });
  await mkdir(join(root, "dist", "cli"), { recursive: true });
  await writeFile(desktopEntry, "");
  await writeFile(cliEntry, "");
  try {
    const sea = await serviceLaunchSpec("/tmp/home", "/tmp/workspace", {
      execPath: "/opt/pspore",
      argvEntry: "/opt/pspore",
      moduleUrl: pathToFileURL("/opt/pspore").href,
    });
    assert.deepEqual(sea.args, ["--home", "/tmp/home", "daemon"]);

    const electron = await serviceLaunchSpec("/tmp/home", "/tmp/workspace", {
      execPath: "/opt/pspore-desktop",
      moduleUrl: pathToFileURL(desktopEntry).href,
      electron: true,
    });
    assert.deepEqual(electron.args, [resolve(cliEntry), "--home", "/tmp/home", "daemon"]);
    assert.deepEqual(electron.environment, { ELECTRON_RUN_AS_NODE: "1" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uses a stable friendly unit for the default home and hashes custom homes", () => {
  assert.equal(serviceUnitName("/home/user/.pspore", "/home/user/.pspore"), "pspore.service");
  assert.match(serviceUnitName("/tmp/custom", "/home/user/.pspore"), /^pspore-[a-f0-9]{12}\.service$/);
});

function result(code: number, stdout = "", stderr = ""): SystemServiceCommandResult {
  return { code, stdout, stderr };
}
