import assert from "node:assert/strict";
import test from "node:test";

import { DesktopDaemonSupervisor } from "../../src/desktop/daemon-supervisor.js";
import { DaemonAlreadyRunningError } from "../../src/storage/daemon-lock.js";

test("desktop owns and stops a daemon it starts", async () => {
  let starts = 0;
  let stops = 0;
  const supervisor = new DesktopDaemonSupervisor({
    home: "/private/pspore",
    startDaemon: async (home) => {
      starts += 1;
      assert.equal(home, "/private/pspore");
      return { stop: async () => { stops += 1; } };
    },
  });

  assert.equal(await supervisor.start(), "owned");
  assert.equal(await supervisor.start(), "owned");
  assert.equal(starts, 1);
  await supervisor.stop();
  assert.equal(stops, 1);
});

test("desktop reuses an external daemon and never stops it", async () => {
  const supervisor = new DesktopDaemonSupervisor({
    home: "/private/pspore",
    startDaemon: async () => { throw new DaemonAlreadyRunningError(42); },
  });

  assert.equal(await supervisor.start(), "external");
  await supervisor.stop();
  assert.equal(supervisor.ownership, undefined);
});

test("desktop surfaces daemon startup failures", async () => {
  const supervisor = new DesktopDaemonSupervisor({
    home: "/private/pspore",
    startDaemon: async () => { throw new Error("invalid config"); },
  });

  await assert.rejects(() => supervisor.start(), /invalid config/);
});
