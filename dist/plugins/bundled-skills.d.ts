/**
 * Skills that ship inside the pSpore release rather than being installed by the
 * user from `workspace/staging`. They are part of the application payload, so
 * they carry the same trust as the binary that runs them and do not go through
 * the staged inspect/install flow.
 *
 * On every startup the release copy is linked into `workspace/skills/<name>` so
 * it is visible and editable-adjacent from the workspace, and so an upgraded
 * release automatically supersedes the previous one.
 */
export interface BundledSkill {
    name: string;
    version: string;
    description?: string;
    /** Absolute path of the skill directory inside the installed release. */
    sourcePath: string;
}
export type BundledSkillLinkAction = "linked" | "relinked" | "upgraded" | "current" | "kept-user-copy" | "failed";
export interface BundledSkillLinkResult {
    name: string;
    version: string;
    action: BundledSkillLinkAction;
    targetPath: string;
    /** Version previously present in the workspace, when one could be determined. */
    previousVersion?: string;
    message?: string;
}
/** Written beside a linked skill so a later startup can tell ours from the user's. */
export declare const BUNDLED_MARKER = ".pspore-bundled.json";
/**
 * Candidate roots for the release's bundled skills, most specific first.
 *
 * The build copies `bundled-skills/` into `dist/`, so a packaged install finds
 * it one level up from this module; a `tsx` run from the source tree finds the
 * repository copy two levels up.
 *
 * Inside an Electron package the module lives in `app.asar`, where entries are
 * not real files. The skills are therefore unpacked next to the archive, and the
 * `.asar` segment is rewritten so the path can be read, symlinked to, and
 * executed like any other directory.
 */
export declare function bundledSkillsRoots(moduleUrl?: string): string[];
/** First candidate root that actually exists, or undefined when none ship. */
export declare function resolveBundledSkillsRoot(moduleUrl?: string): Promise<string | undefined>;
/** Reads every bundled skill shipped in `root`, skipping anything malformed. */
export declare function readBundledSkills(root: string): Promise<BundledSkill[]>;
/**
 * Links every bundled skill into `skillsRoot`, replacing an older linked copy.
 * A directory the user created themselves is never overwritten.
 */
export declare function linkBundledSkills(skills: readonly BundledSkill[], skillsRoot: string): Promise<BundledSkillLinkResult[]>;
/** Numeric SemVer comparison; a prerelease sorts before its own release. */
export declare function compareVersions(left: string, right: string): number;
/** Restores the executable bit that a zip round-trip or asar copy can drop. */
export declare function ensureSkillExecutables(skill: BundledSkill, relativePaths: readonly string[]): Promise<void>;
//# sourceMappingURL=bundled-skills.d.ts.map