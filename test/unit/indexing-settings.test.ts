import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseConfig } from "../../src/config/config.js";
import { decodeDesktopIndexingSettingsUpdate } from "../../src/desktop/ipc-contract.js";
import { IndexingSettingsService } from "../../src/settings/indexing-settings-service.js";
import { initializePsporeHome } from "../../src/storage/home.js";

test("indexing settings round-trip and stay readable by the daemon", async () => {
  const home = await mkdtemp(join(tmpdir(), "pspore-indexing-settings-"));
  try {
    const { paths } = await initializePsporeHome(home);
    const service = new IndexingSettingsService(home, paths);

    const initial = await service.get();
    assert.equal(initial.enabled, false);
    assert.deepEqual(initial.directories, []);
    assert.equal(initial.configPath, paths.config);
    // The release under test ships no indexer binary, and the client is told so
    // rather than silently offering a feature that cannot run.
    assert.equal(initial.indexerAvailable, false);
    assert.match(initial.indexerPath, /skills\/aegis-search\/bin\/aegis-search$/);

    const saved = await service.save({
      enabled: true,
      directories: ["/srv/docs", "/srv/docs", "/home/me/My Documents"],
      intervalMinutes: 45,
      extensions: ["TXT", ".Md"],
    });
    // Duplicates collapse, order is stable, and extensions normalise.
    assert.deepEqual(saved.directories, ["/home/me/My Documents", "/srv/docs"]);
    assert.deepEqual(saved.extensions, ["txt", "md"]);
    assert.equal(saved.intervalMinutes, 45);
    assert.equal(saved.enabled, true);

    // What was written must survive the daemon's own parse.
    const stored = JSON.parse(await readFile(paths.config, "utf8"));
    assert.deepEqual(parseConfig(stored, home).indexing, {
      enabled: true,
      directories: ["/home/me/My Documents", "/srv/docs"],
      intervalMinutes: 45,
      extensions: ["txt", "md"],
    });

    // Saving indexing must not disturb any other config section.
    assert.deepEqual(parseConfig(stored, home).permissions.mode, "ask_risky");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("the desktop indexing decoder rejects what the daemon would refuse", () => {
  const base = { enabled: true, directories: ["/srv/docs"], intervalMinutes: 30, extensions: ["txt"] };
  assert.deepEqual(decodeDesktopIndexingSettingsUpdate(base).directories, ["/srv/docs"]);

  // A relative path means a different directory to every process that reads it.
  assert.throws(
    () => decodeDesktopIndexingSettingsUpdate({ ...base, directories: ["docs"] }),
    /must be an absolute path/,
  );
  assert.throws(
    () => decodeDesktopIndexingSettingsUpdate({ ...base, intervalMinutes: 0 }),
    /between 1 and 10080/,
  );
  assert.throws(
    () => decodeDesktopIndexingSettingsUpdate({ ...base, extensions: [] }),
    /requires at least one extension/,
  );
  assert.throws(
    () => decodeDesktopIndexingSettingsUpdate({ ...base, extensions: ["../etc"] }),
    /short alphanumeric extension/,
  );
  assert.throws(
    () => decodeDesktopIndexingSettingsUpdate({ ...base, enabled: "yes" }),
    /enabled must be boolean/,
  );
  // An unknown field means the client and daemon disagree about the shape.
  assert.throws(
    () => decodeDesktopIndexingSettingsUpdate({ ...base, extra: 1 }),
    /unknown fields: extra/,
  );

  // Paths with spaces and non-ASCII are ordinary and must be accepted.
  const real = decodeDesktopIndexingSettingsUpdate({
    ...base,
    directories: ["/home/me/My Documents", "/home/me/文档"],
  });
  assert.equal(real.directories.length, 2);
});
