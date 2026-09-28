import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { ArticleDraft } from "./preview.js";
import { ArticleStore, cleanTitle, MAX_ARTICLE_CHARS, type ArticleCommit, type ArticleEdit } from "./store.js";
import { writeArticleText, type ArticleWriterModels } from "./writer.js";

const editSchema = Type.Object(
  {
    find: Type.String({ minLength: 1, maxLength: 80_000 }),
    replace: Type.String({ maxLength: 80_000 }),
  },
  { additionalProperties: false },
);

const articleParameters = Type.Object(
  {
    action: Type.Union([Type.Literal("open"), Type.Literal("write"), Type.Literal("create"), Type.Literal("update"), Type.Literal("read")]),
    id: Type.Optional(Type.String({ minLength: 16, maxLength: 16 })),
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    instruction: Type.Optional(Type.String({ minLength: 1, maxLength: 8_000 })),
    content: Type.Optional(Type.String({ maxLength: MAX_ARTICLE_CHARS })),
    edits: Type.Optional(Type.Array(editSchema, { maxItems: 30 })),
    version: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  { additionalProperties: false },
);

interface ArticleDetails {
  id: string;
  title: string;
  version: number;
  chars: number;
  added: number;
  removed: number;
}

interface ArticleOpenDetails {
  opened: true;
  title: string;
  id?: string;
  version?: number;
}

/**
 * The writing surface for a long document.
 *
 * Chat stays a short receipt. The body lives in the article store, one file
 * per version, and the desktop panel renders whichever version is current.
 * `read` is the exception that returns the body: after compaction the model
 * no longer has the text it wrote, and it cannot revise what it cannot see.
 * The desktop broadcast strips that body; the panel loads the file.
 */
export function createArticleTools(sessionId: string, articles: ArticleStore, models?: ArticleWriterModels): ToolDefinition[] {
  const article = defineTool<typeof articleParameters, ArticleDetails | ArticleOpenDetails | { articleDraft: ArticleDraft }>({
    name: "article",
    label: "Article",
    description:
      "Write and revise a document in the panel. To generate prose, use action=write with a short instruction and title (new) or id (revision). The tool streams the document itself using the configured model. Do NOT generate the document in tool arguments or the chat reply. open/read and exact-content create/update are also available.",
    promptSnippet: "Write and revise long documents in the article panel instead of the chat",
    promptGuidelines: [
      "When the user wants a piece of writing they will read as a document, call article instead of putting the document in the chat reply.",
      "The chat reply is one or two sentences. The panel renders the file, shows each version's diff, and exports it.",
      "For generated writing or revisions, call action=write with a concise instruction describing requirements, length, structure and sources, plus title for a new article or id for an existing one. Do not put the article body in the instruction. The writer receives the preceding conversation and the saved version, uses the current model's normal TEXT stream (no tool arguments), opens the panel immediately, and saves one version only after successful completion.",
      "Do not use create/update to generate long prose: OpenAI-compatible gateways may buffer their tool arguments until the end, so the panel cannot stream them. Use those actions only to save exact supplied content or apply a small exact {find, replace} edit.",
      "An optional short action=open with title or id can prepare the panel first. Wait for its result, then use write. Never combine open with document content.",
      "Do not use the edit tool on the article files. read returns the current markdown when you need it again.",
    ],
    parameters: articleParameters,
    executionMode: "sequential",
    execute: async (toolCallId, params, signal, onUpdate, context) => {
      if (signal?.aborted) throw new Error("Article write aborted");
      if (params.action !== "write" && params.instruction !== undefined) throw new Error("instruction is only accepted by article write");
      if (params.action === "write") {
        if (!models) throw new Error("Article text writer is not available in this runtime");
        if (params.content !== undefined || params.edits !== undefined || params.version !== undefined) {
          throw new Error("article write accepts a short instruction, not content/edits/version");
        }
        const instruction = required(params.instruction?.trim(), "article write requires instruction");
        const previous = params.id ? await articles.read({ sessionId, id: params.id, limit: MAX_ARTICLE_CHARS }) : undefined;
        if (params.id && !previous) throw new Error(`No article ${params.id} in this session.`);
        const title = cleanTitle(required(params.title ?? previous?.title, "article write requires title or id"));
        const draft: ArticleDraft = {
          toolCallId, sessionId, action: previous ? "update" : "create", title,
          ...(previous ? { articleId: previous.id } : {}), content: "",
        };
        const preview = (text: string): void => onUpdate?.({ content: [], details: { articleDraft: { ...draft, content: text } } });
        preview("");
        const generated = await writeArticleText({ models, context, toolCallId, title, instruction,
          ...(previous ? { previous: previous.text } : {}), ...(signal ? { signal } : {}), onText: preview });
        if (signal?.aborted) throw new Error("Article write aborted");
        const commit = previous
          ? await articles.update({ sessionId, id: previous.id, title, content: generated.text })
          : await articles.create({ sessionId, title, content: generated.text });
        return { content: [{ type: "text", text: formatCommit(commit) }], details: detailsOf(commit), usage: generated.usage };
      }
      if (params.action === "open") {
        if (params.content !== undefined || params.edits !== undefined || params.version !== undefined) {
          throw new Error("article open accepts only title or id; generate the document in the next write call");
        }
        const document = params.id ? await articles.read({ sessionId, id: params.id, limit: 1 }) : undefined;
        if (params.id && !document) throw new Error(`No article ${params.id} in this session.`);
        const title = document?.title ?? cleanTitle(required(params.title?.trim(), "article open requires title or id"));
        return {
          content: [{ type: "text", text: [
            document ? `article open ${document.id} version ${document.version}` : "article open",
            `标题：${title}`,
            "文稿面板已打开，尚未写入新版本。",
            document ? `Next: write with id ${document.id} and a short revision instruction.` : "Next: write with this title and a short writing instruction; do not generate the body in tool arguments.",
          ].join("\n") }],
          details: { opened: true, title, ...(document ? { id: document.id, version: document.version } : {}) },
        };
      }
      if (params.action === "read") {
        if (!params.id) throw new Error("article read requires id");
        const document = await articles.read({
          sessionId,
          id: params.id,
          ...(params.version === undefined ? {} : { version: params.version }),
          limit: MAX_ARTICLE_CHARS,
        });
        if (!document) throw new Error(`No article ${params.id} in this session.`);
        const text = [
          receiptLine(document.id, document.version),
          `标题：${document.title}`,
          `${document.length} 字。正文如下，只用于继续修改，不要复制到聊天回复。`,
          "",
          document.text,
        ].join("\n");
        return {
          content: [{ type: "text", text }],
          details: detailsOf({
            id: document.id,
            title: document.title,
            version: document.version,
            chars: document.length,
            added: 0,
            removed: 0,
          }),
        };
      }
      const commit = params.action === "create"
        ? await articles.create({
            sessionId,
            title: required(params.title, "article create requires title"),
            content: required(params.content, "article create requires content"),
          })
        : await articles.update({
            sessionId,
            id: required(params.id, "article update requires id"),
            ...(params.title === undefined ? {} : { title: params.title }),
            ...(params.content === undefined ? {} : { content: params.content }),
            ...(params.edits === undefined ? {} : { edits: params.edits as ArticleEdit[] }),
          });
      return {
        content: [{ type: "text", text: formatCommit(commit) }],
        details: detailsOf(commit),
      };
    },
  });
  return [article];
}

function formatCommit(commit: ArticleCommit): string {
  const change = commit.unchanged
    ? "内容没有变化，仍是这一版。"
    : commit.version === 1
      ? `新文稿，${commit.added} 段。`
      : `相对上一版 +${commit.added} 段 −${commit.removed} 段。`;
  return [
    receiptLine(commit.id, commit.version),
    `标题：${commit.title}`,
    `${commit.chars} 字，${change}`,
    `文件：${commit.path}`,
    "在文稿面板查看和导出。聊天回复只用一两句话，不要粘贴正文。",
  ].join("\n");
}

function receiptLine(id: string, version: number): string {
  return `article ${id} version ${version}`;
}

function detailsOf(commit: Pick<ArticleCommit, "id" | "title" | "version" | "chars" | "added" | "removed">): ArticleDetails {
  return {
    id: commit.id,
    title: commit.title,
    version: commit.version,
    chars: commit.chars,
    added: commit.added,
    removed: commit.removed,
  };
}

function required(value: string | undefined, message: string): string {
  if (!value) throw new Error(message);
  return value;
}
