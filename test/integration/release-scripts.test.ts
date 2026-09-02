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
    assert.equal((await stat(launcher)).mode & 0o777, 0o700);

    await execFileAsync(launcher, [], { env: environment });
    assert.equal((await readFile(probe, "utf8")).trim(), installDirectory);
    const log = await readFile(join(stateHome, "pspore", "desktop-launcher.log"), "utf8");
    assert.match(log, /launching .*pspore-desktop/);

    if (await commandExists("desktop-file-validate")) {
      await execFileAsync("desktop-file-validate", [desktopEntry]);
    }
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

    const resources = await readdir(join(fixture.target, "resources"), { withFileTypes: true });
    const backupName = resources.find((entry) => entry.isDirectory() && entry.name.startsWith(".pspore-backup-"))?.name;
    assert.ok(backupName);
    const backup = join(fixture.target, "resources", backupName);
    assert.equal(await readFile(join(backup, "app.asar"), "utf8"), "version=0.1.5\n");
    assert.equal(await readFile(join(backup, "app.asar.unpacked", "old-only.txt"), "utf8"), "old payload\n");
    assert.match(await readFile(fixture.systemctlLog, "utf8"), /--user restart pspore\.service/);
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
      (await readdir(join(fixture.target, "resources"))).filter((name) => name.startsWith(".pspore-backup-")),
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
  target: string;
  systemctlLog: string;
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
  const fakeBin = join(root, "bin");
  const updater = join(overlay, "覆盖升级.sh");
  const systemctlLog = join(root, "systemctl.log");
  await mkdir(join(payloadResources, "app.asar.unpacked"), { recursive: true });
  await mkdir(join(targetResources, "app.asar.unpacked"), { recursive: true });
  await mkdir(join(configHome, "systemd", "user"), { recursive: true });
  await mkdir(fakeBin, { recursive: true });

  await copyFile(overlayScript, updater);
  await chmod(updater, 0o755);
  await writeFile(join(payloadResources, "app.asar"), "version=0.1.6\n");
  await writeFile(join(payloadResources, "app.asar.unpacked", "native.txt"), "new native payload\n");
  await writeFile(join(payloadResources, "app-update.yml"), "version: 0.1.6\n");
  await writeFile(join(targetResources, "app.asar"), "version=0.1.5\n");
  await writeFile(join(targetResources, "app.asar.unpacked", "old-only.txt"), "old payload\n");
  await writeFile(join(targetResources, "app-update.yml"), "version: 0.1.5\n");

  await writeFile(join(target, "pspore-desktop"), [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
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
  ].join("\n"));
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
    target,
    systemctlLog,
    environment: {
      ...process.env,
      HOME: join(root, "home"),
      XDG_CONFIG_HOME: configHome,
      PATH: `${fakeBin}:${process.env["PATH"] ?? ""}`,
      PSPORE_SYSTEMCTL_LOG: systemctlLog,
    },
  };
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
