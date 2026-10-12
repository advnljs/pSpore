import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../..");
const shortcutScript = join(repositoryRoot, "scripts", "linux", "create-desktop-shortcut.sh");
const overlayScript = join(repositoryRoot, "scripts", "linux", "apply-overlay-upgrade.sh");
const overlayGuiScript = join(repositoryRoot, "scripts", "linux", "overlay-upgrade-gui.sh");

test("desktop shortcut uses a stable launcher and records launch diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "pspore-shortcut-"));
  const installDirectory = join(root, "install 100% ready");
  const home = join(root, "home");
  const dataHome = join(root, "xdg data 20%");
  const stateHome = join(root, "xdg state");
  const probe = join(root, "launched-from.txt");
  const packagedScript = join(installDirectory, "创建桌面快捷方式.sh");
  const executable = join(installDirectory, "pspore-desktop");
  try {
    await mkdir(join(home, "Desktop"), { recursive: true });
    await mkdir(installDirectory, { recursive: true });
    await seedIcons(installDirectory);
    await copyFile(shortcutScript, packagedScript);
    await writeFile(executable, [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'printf \'%s\\n\' "$PWD" > "$PSPORE_SHORTCUT_PROBE"',
      "",
    ].join("\n"));
    await chmod(packagedScript, 0o755);
    await chmod(executable, 0o755);

    const environment = {
      ...process.env,
      HOME: home,
      XDG_DATA_HOME: dataHome,
      XDG_STATE_HOME: stateHome,
      PSPORE_SHORTCUT_SKIP_NOTIFY: "1",
      PSPORE_SHORTCUT_PROBE: probe,
      DISPLAY: "",
      WAYLAND_DISPLAY: "",
    };
    await execFileAsync("bash", [packagedScript], { env: environment });

    const launcher = join(dataHome, "pspore", "bin", "pspore-desktop-launcher");
    const desktopEntry = join(dataHome, "applications", "pSpore.desktop");
    const desktop = await readFile(desktopEntry, "utf8");
    const escapedLauncher = launcher.replaceAll("%", "%%");
    assert.match(desktop, new RegExp(`^Exec="${escapeRegex(escapedLauncher)}"$`, "m"));
    assert.doesNotMatch(desktop, /^Path=/m);
    assert.doesNotMatch(desktop, new RegExp(escapeRegex(installDirectory)));
    assert.match(desktop, /^Icon=pspore$/m);
    assert.match(desktop, /^StartupWMClass=pSpore$/m);
    assert.deepEqual(
      await readFile(join(dataHome, "icons/hicolor/512x512/apps/pspore.png")),
      await readFile(join(repositoryRoot, "src/desktop/assets/pspore.png")),
    );
    assert.deepEqual(
      await readFile(join(dataHome, "icons/hicolor/scalable/apps/pspore.svg")),
      await readFile(join(repositoryRoot, "src/desktop/assets/pspore.svg")),
    );
    assert.equal((await stat(launcher)).mode & 0o777, 0o700);

    await execFileAsync(launcher, [], { env: environment });
    assert.equal((await readFile(probe, "utf8")).trim(), installDirectory);
    const log = await readFile(join(stateHome, "pspore", "desktop-launcher.log"), "utf8");
    assert.match(log, /launching .*pspore-desktop/);

    if (await commandExists("desktop-file-validate")) {
      await execFileAsync("desktop-file-validate", [desktopEntry]);
    }
    // Reinstall into another versioned directory. A pinned desktop ID, Exec and
    // icon name must stay unchanged while the stable launcher follows the move.
    const upgradedDirectory = join(root, "next install");
    await mkdir(upgradedDirectory);
    await seedIcons(upgradedDirectory);
    // ZIP extraction may remove executable bits. The installer restores the
    // native entry and preserves every argument, including shell characters.
    const native = join(upgradedDirectory, "resources/native/pspore-startup");
    await mkdir(join(upgradedDirectory, "resources/native"), { recursive: true });
    await writeFile(native, "#!/usr/bin/env bash\nprintf '%s\\n' \"$@\" > \"$PSPORE_NATIVE_PROBE\"\nexec \"$@\"\n", { mode: 0o644 });
    await copyFile(executable, join(upgradedDirectory, "pspore-desktop"));
    await copyFile(shortcutScript, join(upgradedDirectory, "创建桌面快捷方式.sh"));
    await execFileAsync("bash", [join(upgradedDirectory, "创建桌面快捷方式.sh")], { env: environment });
    assert.equal(await readFile(desktopEntry, "utf8"), desktop);
    const nativeProbe = join(root, "native-arguments.txt");
    await execFileAsync(launcher, ["argument with spaces", "literal $x;`q`"], { env: { ...environment, PSPORE_NATIVE_PROBE: nativeProbe } });
    assert.equal((await stat(native)).mode & 0o111, 0o111);
    assert.deepEqual((await readFile(nativeProbe, "utf8")).trimEnd().split("\n"), [join(upgradedDirectory, "pspore-desktop"), "argument with spaces", "literal $x;`q`"]);
    assert.equal((await readFile(probe, "utf8")).trim(), upgradedDirectory);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop launcher recovers from native loader failures without reopening after cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pspore-launcher-recovery-"));
  const installDirectory = join(root, "install with spaces");
  const dataHome = join(root, "data");
  const stateHome = join(root, "state");
  const probe = join(root, "arguments.txt");
  const native = join(installDirectory, "resources/native/pspore-startup");
  const environment = {
    ...process.env,
    HOME: join(root, "home"), XDG_DATA_HOME: dataHome, XDG_STATE_HOME: stateHome,
    DISPLAY: "", WAYLAND_DISPLAY: "", PSPORE_SHORTCUT_SKIP_NOTIFY: "1",
    PSPORE_SHORTCUT_PROBE: probe, PSPORE_STARTUP_SOCKET: "stale-controller",
  };
  try {
    await seedIcons(installDirectory);
    await mkdir(join(installDirectory, "resources/native"), { recursive: true });
    const installer = join(installDirectory, "创建桌面快捷方式.sh");
    await copyFile(shortcutScript, installer);
    await writeFile(join(installDirectory, "pspore-desktop"), [
      "#!/usr/bin/env bash", "set -euo pipefail",
      '[[ -z "${PSPORE_STARTUP_SOCKET:-}" ]]',
      'printf \'%s\\n\' "$PWD" "$@" > "$PSPORE_SHORTCUT_PROBE"', "",
    ].join("\n"), { mode: 0o755 });
    await execFileAsync("bash", [installer], { env: environment });
    const launcher = join(dataHome, "pspore/bin/pspore-desktop-launcher");
    const args = ["argument with spaces", "literal $x;`q`"];
    for (const source of [
      // The kernel fails before main(), just like an unavailable ELF loader.
      "#!/missing/pspore-test-interpreter\n",
      "#!/usr/bin/env bash\necho 'symbol lookup error: native dependency' >&2\nexit 127\n",
      "#!/usr/bin/env bash\nulimit -c 0\nkill -SEGV \"$$\"\n",
    ]) {
      await writeFile(native, source, { mode: 0o755 });
      await execFileAsync(launcher, args, { env: environment });
      assert.deepEqual((await readFile(probe, "utf8")).trimEnd().split("\n"), [installDirectory, ...args]);
      await rm(probe);
    }
    const log = await readFile(join(stateHome, "pspore/desktop-launcher.log"), "utf8");
    assert.equal(log.match(/falling back to Electron/g)?.length, 3);
    assert.match(log, /symbol lookup error: native dependency/);
    // Native 0 also represents user cancellation and second-instance focus.
    await writeFile(native, "#!/usr/bin/env bash\nexit 0\n");
    await execFileAsync(launcher, args, { env: environment });
    await assert.rejects(readFile(probe), { code: "ENOENT" });
    assert.equal(await readFile(join(stateHome, "pspore/desktop-launcher.log"), "utf8").then((value) => value.match(/falling back to Electron/g)?.length), 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("overlay upgrade validates compatibility, replaces the full app payload, and keeps a rollback", async () => {
  const fixture = await createOverlayFixture();
  try {
    const result = await execFileAsync("bash", [fixture.updater, fixture.target], {
      env: fixture.environment,
      maxBuffer: 2_000_000,
    });
    assert.match(result.stdout, /升级成功/);
    assert.match(result.stdout, /pSpore 0\.1\.5/);
    assert.match(result.stdout, /pSpore 0\.1\.6/);
    assert.match(result.stdout, /Electron 运行时: 43\.3\.0/);
    assert.equal(await readFile(join(fixture.target, "resources", "app.asar"), "utf8"), "version=0.1.6\n");
    assert.equal(
      await readFile(join(fixture.target, "resources", "app.asar.unpacked", "native.txt"), "utf8"),
      "new native payload\n",
    );
    await assert.rejects(readFile(join(fixture.target, "resources", "app.asar.unpacked", "old-only.txt")));
    // Everything outside the Chromium runtime is replaced, not just resources/.
    assert.equal(await readFile(join(fixture.target, "安装说明.txt"), "utf8"), "pSpore Desktop 0.1.6\n");
    assert.equal(await readFile(join(fixture.target, "pspore-desktop"), "utf8"), fixture.runtimeSource);
    assert.match(result.stdout, /\[\s*100%\] 升级完成/);
    assert.match(result.stdout, /个人配置 \(~\/\.pspore\) 未改动/);

    const entries = await readdir(fixture.target, { withFileTypes: true });
    const backupName = entries.find((entry) => entry.isDirectory() && entry.name.startsWith(".pspore-backup-"))?.name;
    assert.ok(backupName);
    const backup = join(fixture.target, backupName);
    assert.equal(await readFile(join(backup, "resources", "app.asar"), "utf8"), "version=0.1.5\n");
    assert.equal(await readFile(join(backup, "resources", "app.asar.unpacked", "old-only.txt"), "utf8"), "old payload\n");
    assert.match(await readFile(fixture.systemctlLog, "utf8"), /--user restart pspore\.service/);
    // An existing shortcut must end up pointing at the directory just upgraded.
    assert.match(result.stdout, /已将桌面快捷方式指向本次升级的安装目录/);
    assert.equal((await readFile(fixture.installRecord, "utf8")).trim(), fixture.target);
    const native = join(fixture.target, "resources/native/pspore-startup");
    assert.equal((await stat(native)).mode & 0o111, 0o111);
    const launcher = join(fixture.environment["XDG_DATA_HOME"]!, "pspore/bin/pspore-desktop-launcher");
    await execFileAsync(launcher, ["overlay argument"], { env: fixture.environment });
    assert.equal(await readFile(join(fixture.root, "native-entry.txt"), "utf8"), `${join(fixture.target, "pspore-desktop")}\noverlay argument\n`);
    // The refreshed existing launcher must recover even if the upgraded native
    // helper cannot load on the target desktop.
    await writeFile(native, "#!/missing/pspore-test-interpreter\n");
    await execFileAsync(launcher, [], { env: fixture.environment });
    assert.match(await readFile(join(fixture.environment["XDG_STATE_HOME"]!, "pspore/desktop-launcher.log"), "utf8"), /falling back to Electron/);
    assert.equal(await readFile(join(fixture.root, "native-entry.txt.direct"), "utf8"), "desktop started\n");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("the overlay GUI selects a directory, reports progress, and refuses a wrong one", async () => {
  const fixture = await createOverlayFixture();
  try {
    const zenityLog = join(fixture.root, "zenity.log");
    // A stub zenity records how it is invoked and answers the directory prompt,
    // so the wrapper's dialog wiring is exercised without a display server.
    await writeFile(join(fixture.root, "bin", "zenity"), [
      "#!/usr/bin/env bash",
      "set -uo pipefail",
      'printf \'%s\\n\' "$*" >> "$PSPORE_ZENITY_LOG"',
      'for argument in "$@"; do',
      '  if [[ "$argument" == "--file-selection" ]]; then',
      '    printf \'%s\\n\' "$PSPORE_ZENITY_DIRECTORY"',
      "    exit 0",
      "  fi",
      '  if [[ "$argument" == "--progress" ]]; then',
      '    cat >> "$PSPORE_ZENITY_LOG"',
      "    exit 0",
      "  fi",
      "done",
      "exit 0",
      "",
    ].join("\n"));
    await chmod(join(fixture.root, "bin", "zenity"), 0o755);

    const environment = {
      ...fixture.environment,
      PSPORE_ZENITY_LOG: zenityLog,
      PSPORE_ZENITY_DIRECTORY: fixture.target,
    };
    await writeFile(zenityLog, "");
    const result = await execFileAsync("bash", [fixture.gui], { env: environment, maxBuffer: 2_000_000 });
    assert.equal(result.stdout, "");
    const dialogs = await readFile(zenityLog, "utf8");
    assert.match(dialogs, /--file-selection --directory/);
    // zenity's progress protocol: bare percentages plus "# message" lines.
    assert.match(dialogs, /^100$/m);
    assert.match(dialogs, /^# 升级完成$/m);
    assert.equal(await readFile(join(fixture.target, "resources", "app.asar"), "utf8"), "version=0.1.6\n");

    // A directory that is not an install must be rejected before anything runs.
    const wrong = join(fixture.root, "not-an-install");
    await mkdir(wrong, { recursive: true });
    await writeFile(zenityLog, "");
    await assert.rejects(
      execFileAsync("bash", [fixture.gui], { env: { ...environment, PSPORE_ZENITY_DIRECTORY: wrong } }),
      () => true,
    );
    assert.match(await readFile(zenityLog, "utf8"), /--error/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("overlay upgrade rejects a tampered payload before changing the install", async () => {
  const fixture = await createOverlayFixture();
  try {
    await writeFile(join(fixture.overlay, "payload", "resources", "app.asar"), "version=9.9.9\n");
    await assert.rejects(
      execFileAsync("bash", [fixture.updater, fixture.target], { env: fixture.environment }),
      (error: unknown) => {
        const candidate = error as Error & { stderr?: string };
        assert.match(candidate.stderr ?? candidate.message, /payload 校验失败/);
        return true;
      },
    );
    assert.equal(await readFile(join(fixture.target, "resources", "app.asar"), "utf8"), "version=0.1.5\n");
    assert.deepEqual(
      (await readdir(fixture.target)).filter((name) => name.startsWith(".pspore-backup-")),
      [],
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("overlay upgrade accepts a matching Linux ARM64 runtime", async () => {
  const fixture = await createOverlayFixture("arm64");
  try {
    const result = await execFileAsync("bash", [fixture.updater, fixture.target], {
      env: fixture.environment,
      maxBuffer: 2_000_000,
    });
    assert.match(result.stdout, /升级成功/);
    assert.match(result.stdout, /Electron 运行时: 43\.3\.0 \(linux\/arm64/);
    assert.equal(await readFile(join(fixture.target, "resources", "app.asar"), "utf8"), "version=0.1.6\n");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

interface OverlayFixture {
  root: string;
  overlay: string;
  updater: string;
  gui: string;
  target: string;
  systemctlLog: string;
  installRecord: string;
  runtimeSource: string;
  environment: NodeJS.ProcessEnv;
}

async function createOverlayFixture(architecture: "x64" | "arm64" = "x64"): Promise<OverlayFixture> {
  const root = await mkdtemp(join(tmpdir(), "pspore-overlay-"));
  const overlay = join(root, "overlay");
  const payload = join(overlay, "payload");
  const payloadResources = join(payload, "resources");
  const target = join(root, "existing install");
  const targetResources = join(target, "resources");
  const configHome = join(root, "config");
  const dataHome = join(root, "xdg-data");
  const fakeBin = join(root, "bin");
  const updater = join(overlay, "覆盖升级.sh");
  const gui = join(overlay, "图形界面升级.sh");
  const systemctlLog = join(root, "systemctl.log");
  const installRecord = join(dataHome, "pspore", "install-dir");
  await mkdir(join(payloadResources, "app.asar.unpacked"), { recursive: true });
  await seedIcons(payload);
  await mkdir(join(payloadResources, "native"));
  await writeFile(join(payloadResources, "native/pspore-startup"), "#!/usr/bin/env bash\nprintf '%s\\n' \"$@\" > \"$PSPORE_NATIVE_PROBE\"\n", { mode: 0o644 });
  await mkdir(join(targetResources, "app.asar.unpacked"), { recursive: true });
  await mkdir(join(configHome, "systemd", "user"), { recursive: true });
  await mkdir(join(dataHome, "pspore"), { recursive: true });
  await mkdir(join(dataHome, "applications"), { recursive: true });
  await mkdir(join(root, "home", "Desktop"), { recursive: true });
  await mkdir(fakeBin, { recursive: true });

  await copyFile(overlayScript, updater);
  await chmod(updater, 0o755);
  await copyFile(overlayGuiScript, gui);
  await chmod(gui, 0o755);
  // The payload replaces every application file, so it also carries the
  // non-resources files a real overlay ships.
  await writeFile(join(payload, "安装说明.txt"), "pSpore Desktop 0.1.6\n");
  await copyFile(shortcutScript, join(payload, "创建桌面快捷方式.sh"));
  await chmod(join(payload, "创建桌面快捷方式.sh"), 0o755);
  // A shortcut installed against an older copy must be re-pointed on upgrade.
  await writeFile(installRecord, `${join(root, "stale install")}\n`);
  await writeFile(join(payloadResources, "app.asar"), "version=0.1.6\n");
  await writeFile(join(payloadResources, "app.asar.unpacked", "native.txt"), "new native payload\n");
  await writeFile(join(payloadResources, "app-update.yml"), "version: 0.1.6\n");
  await writeFile(join(targetResources, "app.asar"), "version=0.1.5\n");
  await writeFile(join(targetResources, "app.asar.unpacked", "old-only.txt"), "old payload\n");
  await writeFile(join(targetResources, "app-update.yml"), "version: 0.1.5\n");
  await writeFile(join(target, "安装说明.txt"), "pSpore Desktop 0.1.5\n");

  const runtimeSource = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'if (( $# == 0 )); then',
    '  printf \'desktop started\\n\' > "$PSPORE_NATIVE_PROBE.direct"',
    "  exit 0",
    "fi",
    'if [[ "${1:-}" == "-e" && "${2:-}" == *"process.versions.electron"* ]]; then',
    `  printf '%s\\nlinux\\n${architecture}\\n' "\${PSPORE_FIXTURE_ELECTRON:-43.3.0}"`,
    "  exit 0",
    "fi",
    'if [[ "${1:-}" == "-e" ]]; then',
    `  exec "${process.execPath}" "$@"`,
    "fi",
    'if [[ "${1:-}" == */app.asar/dist/cli/main.js && "${2:-}" == "version" ]]; then',
    '  asar="${1%/dist/cli/main.js}"',
    '  version="$(sed -n \'s/^version=//p\' "$asar")"',
    '  printf \'pSpore %s (fixture)\\n\' "$version"',
    "  exit 0",
    "fi",
    "exit 2",
    "",
  ].join("\n");
  await writeFile(join(target, "pspore-desktop"), runtimeSource);
  await chmod(join(target, "pspore-desktop"), 0o755);

  await writeFile(join(fakeBin, "systemctl"), [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'printf \'%s\\n\' "$*" >> "$PSPORE_SYSTEMCTL_LOG"',
    "",
  ].join("\n"));
  await chmod(join(fakeBin, "systemctl"), 0o755);
  await writeFile(systemctlLog, "");
  await writeFile(
    join(configHome, "systemd", "user", "pspore.service"),
    `[Service]\nExecStart="${target}/pspore-desktop" "${target}/resources/app.asar/dist/cli/main.js" daemon\n`,
  );

  await writeFile(join(overlay, "overlay-manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    appVersion: "0.1.6",
    electronVersion: "43.3.0",
    platform: "linux",
    arch: architecture,
    payloadSha256: await payloadDigest(payload),
  }, null, 2)}\n`);

  return {
    root,
    overlay,
    updater,
    gui,
    target,
    systemctlLog,
    installRecord,
    runtimeSource,
    environment: {
      ...process.env,
      HOME: join(root, "home"),
      XDG_CONFIG_HOME: configHome,
      XDG_DATA_HOME: dataHome,
      XDG_STATE_HOME: join(root, "xdg-state"),
      PATH: `${fakeBin}:${process.env["PATH"] ?? ""}`,
      PSPORE_SYSTEMCTL_LOG: systemctlLog,
      PSPORE_NATIVE_PROBE: join(root, "native-entry.txt"),
      PSPORE_SHORTCUT_SKIP_NOTIFY: "1",
      DISPLAY: "",
      WAYLAND_DISPLAY: "",
    },
  };
}

async function seedIcons(directory: string): Promise<void> {
  await mkdir(join(directory, "resources/icons"), { recursive: true });
  for (const file of ["pspore.png", "pspore.svg"]) {
    await copyFile(join(repositoryRoot, "src/desktop/assets", file), join(directory, "resources/icons", file));
  }
}

async function payloadDigest(root: string): Promise<string> {
  const files: Array<[string, string]> = [];
  async function walk(directory: string, prefix = ""): Promise<void> {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute, relative);
      else if (entry.isFile()) files.push([relative, absolute]);
      else throw new Error(`Unsupported fixture payload entry: ${relative}`);
    }
  }
  await walk(root);
  const hash = createHash("sha256");
  for (const [relative, absolute] of files) {
    const data = await readFile(absolute);
    hash.update(relative, "utf8");
    hash.update("\0");
    hash.update(String(data.length), "utf8");
    hash.update("\0");
    hash.update(data);
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFileAsync("sh", ["-c", `command -v "$1" >/dev/null 2>&1`, "sh", command]);
    return true;
  } catch {
    return false;
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
