import assert from "node:assert/strict";
import test from "node:test";

import {
  composeMessageWithFileReferences,
  composerFileReference,
  composerFileReferenceName,
  composerFileReferenceToken,
  MAX_COMPOSER_FILE_REFERENCES,
  mergeComposerFileReferences,
  type ComposerFileReference,
} from "../../src/desktop/renderer/composer-file-references.js";

test("composer accepts only bounded absolute dropped paths", () => {
  assert.deepEqual(composerFileReference("/home/user/project/readme.md", "file"), {
    path: "/home/user/project/readme.md",
    kind: "file",
  });
  assert.equal(composerFileReference("relative/file.txt", "file"), undefined);
  assert.equal(composerFileReference("/tmp/line\nbreak", "file"), undefined);
  assert.equal(composerFileReference(`/tmp/${"x".repeat(4_096)}`, "file"), undefined);
});

test("composer deduplicates dropped file and directory references and caps their count", () => {
  const existing: ComposerFileReference[] = [{ path: "/tmp/already.txt", kind: "file" }];
  const incoming: ComposerFileReference[] = [
    { path: "/tmp/already.txt", kind: "directory" },
    { path: "/tmp/project", kind: "directory" },
    { path: "/tmp/new.txt", kind: "file" },
  ];
  assert.deepEqual(mergeComposerFileReferences(existing, incoming, 2), {
    references: [existing[0], incoming[1]],
    added: 1,
    skipped: 2,
  });

  const many = Array.from({ length: MAX_COMPOSER_FILE_REFERENCES + 2 }, (_, index) => ({
    path: `/tmp/reference-${index}`,
    kind: "file" as const,
  }));
  const capped = mergeComposerFileReferences([], many);
  assert.equal(capped.references.length, MAX_COMPOSER_FILE_REFERENCES);
  assert.equal(capped.added, MAX_COMPOSER_FILE_REFERENCES);
  assert.equal(capped.skipped, 2);
});

test("composer sends path-only @ references without reading or embedding content", () => {
  const references: ComposerFileReference[] = [
    { path: "/home/user/project/file with spaces.md", kind: "file" },
    { path: "/home/user/project/source", kind: "directory" },
  ];
  assert.equal(composerFileReferenceToken(references[0]!), '@"/home/user/project/file with spaces.md"');
  assert.equal(
    composeMessageWithFileReferences("请检查这些内容", references),
    '请检查这些内容\n\n@"/home/user/project/file with spaces.md"\n@"/home/user/project/source"',
  );
  assert.equal(composeMessageWithFileReferences("", references), '@"/home/user/project/file with spaces.md"\n@"/home/user/project/source"');
  assert.equal(composerFileReferenceName("/home/user/project/source/"), "source");
  assert.throws(() => composeMessageWithFileReferences("abcd", [], 3), /不能超过 3 个字符/);
});
