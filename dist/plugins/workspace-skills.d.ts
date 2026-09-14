import type { SessionSkill, SkillCatalogEntry, SkillSource } from "./types.js";
/**
 * Skills the user put under `workspace/skills/` themselves — copied in by hand,
 * unpacked from somewhere else, or written in an earlier conversation.
 *
 * Discovery follows Pi's own rules so a skill that works in Pi works here: a
 * directory holding `SKILL.md` is one skill and is not searched further, other
 * directories are searched for one, and a Markdown file directly in the root is
 * a skill only when its frontmatter says so.
 *
 * Resolution is deliberately more forgiving than Pi's, because Pi drops a skill
 * without telling anyone when its frontmatter is not strict YAML — which is what
 * an unquoted `description: 发送邮件: 支持附件` is — or has no description at all.
 * Such a skill is still loaded here, and the catalog says what was assumed; one
 * that really cannot be loaded is listed with the reason instead of vanishing.
 */
export interface WorkspaceSkillScanOptions {
    /** Top-level entries pSpore manages itself (bundled skill links); never scanned. */
    managedNames?: ReadonlySet<string>;
    /** Names bundled or installed skills already own; a workspace skill reusing one is shadowed. */
    reservedNames?: ReadonlyMap<string, SkillSource>;
}
export interface WorkspaceSkillScan {
    /** Loadable skills, unique by name, in a stable order. */
    skills: SessionSkill[];
    /** Every skill-shaped entry found, including the ones that were not loaded. */
    catalog: SkillCatalogEntry[];
}
export declare function scanWorkspaceSkills(root: string, options?: WorkspaceSkillScanOptions): Promise<WorkspaceSkillScan>;
/**
 * What a skill without a declared description is for, taken from its opening:
 * the first heading and the first paragraph after it. Code, tables, quotes of
 * markup and further headings are not descriptions and are passed over.
 */
export declare function deriveSkillDescription(body: string): string;
//# sourceMappingURL=workspace-skills.d.ts.map