import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import { resolveUserShell, ShellService } from "../../src/shell/shell-service.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

async function fixture(shell = "/bin/bash") {
  const root = await mkdtemp(join(tmpdir(), "pspore-shell-"));
  roots.push(root);
  const service = new ShellService({
    artifactRoot: join(root, "artifacts"),
    configuredShell: shell,
    env: { ...process.env, HOME: root },
  });
  await service.initialize();
  return { root, service };
}

describe("ShellService Linux contract", () => {
  test("resolves config, inherited SHELL and passwd in precedence order", async () => {
    const root = await mkdtemp(join(tmpdir(), "pspore-passwd-"));
    roots.push(root);
    const passwd = join(root, "passwd");
    await writeFile(passwd, `tester:x:4242:4242::${root}:/bin/sh\n`, { mode: 0o600 });

    const configured = await resolveUserShell({ configuredShell: "/bin/bash", env: {}, uid: 4242, passwdPath: passwd });
    assert.equal(configured.source, "config");
    assert.match(configured.path, /bash$/);

    const inherited = await resolveUserShell({ env: { SHELL: "/bin/sh" }, uid: 4242, passwdPath: passwd });
    assert.equal(inherited.source, "environment");

    const fromPasswd = await resolveUserShell({ env: {}, uid: 4242, passwdPath: passwd });
    assert.equal(fromPasswd.source, "passwd");
    assert.match(fromPasswd.path, /sh$/);
  });

  test("runs login-shell pipe mode and writes a private, hashed artifact", async () => {
    const { root, service } = await fixture();
    const result = await service.run({
      command: "printf 'out:%s' \"$PSPORE_TEST_VALUE\"; printf 'err' >&2",
      cwd: root,
      envDelta: { PSPORE_TEST_VALUE: "ok" },
      mode: "pipe",
      timeoutMs: 2_000,
      maxOutputBytes: 16_384,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "out:ok");
    assert.equal(result.stderr, "err");
    const artifact = await readFile(result.artifactPath);
    assert.equal(createHash("sha256").update(artifact).digest("hex"), result.artifactSha256);
    assert.equal((await stat(result.artifactPath)).mode & 0o777, 0o600);
    await access(result.artifactPath);
  });

  test("terminates commands at timeout and output limits", async () => {
    const { root, service } = await fixture();
    const timedOut = await service.run({
      command: "sleep 5",
      cwd: root,
      mode: "pipe",
      timeoutMs: 60,
      maxOutputBytes: 1_024,
    });
    assert.equal(timedOut.timedOut, true);

    const limited = await service.run({
      command: "yes x | head -c 10000",
      cwd: root,
      mode: "pipe",
      timeoutMs: 2_000,
      maxOutputBytes: 1_024,
    });
    assert.equal(limited.outputLimitExceeded, true);
    assert.equal(limited.capturedBytes, 1_024);
    assert.ok((await stat(limited.artifactPath)).size < 1_200);
  });

  test("uses a PTY secret input channel without storing the secret", async () => {
    const { root, service } = await fixture();
    const doctor = await service.doctor();
    assert.equal(doctor.pty.available, true);

    const handle = await service.start({
      command: "read -rs value; printf 'secret-length:%s\\n' \"${#value}\"",
      cwd: root,
      mode: "pty",
      timeoutMs: 3_000,
      maxOutputBytes: 16_384,
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    await handle.write("not-persisted\n", { secret: true });
    const result = await handle.completion;

    assert.equal(result.exitCode, 0);
    const artifact = await readFile(result.artifactPath, "utf8");
    assert.match(artifact, /secret-length:13/);
    assert.doesNotMatch(artifact, /not-persisted/);
  });
});
