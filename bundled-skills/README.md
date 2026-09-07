# Bundled skills

Skills that ship inside the pSpore release. On startup the daemon links each one
into `workspace/skills/<name>` and offers it to Pi alongside user-installed
skills; see `src/plugins/bundled-skills.ts`.

They deliberately bypass the staged inspect/install trust flow: they arrive in
the same package as the binary that runs them, so they are already exactly as
trusted as pSpore itself.

Each skill directory needs a root `SKILL.md` whose frontmatter carries `name`,
`description` and a SemVer `version`. The version is what lets an upgraded
release supersede a copy an older release left in the workspace.

Native helper binaries are not committed here. `scripts/fetch-bundled-binaries.sh`
downloads them from their own upstream release during packaging, pinned by
version and verified by SHA-256.
