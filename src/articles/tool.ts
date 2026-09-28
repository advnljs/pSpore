import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { ArticleStore, cleanTitle, MAX_ARTICLE_CHARS, type ArticleCommit, type ArticleEdit } from "./store.js";

const editSchema = Type.Object(
  {
    find: Type.String({ minLength: 1, maxLength: 80_000 }),
    replace: Type.String({ maxLength: 80_000 }),
  },
  { additionalProperties: false },
);

const articleParameters = Type.Object(
  {
    action: Type.Union([Type.Literal("open"), Type.Literal("create"), Type.Literal("update"), Type.Literal("read")]),
    id: Type.Optional(Type.String({ minLength: 16, maxLength: 16 })),
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
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
export function createArticleTools(sessionId: string, articles: ArticleStore): ToolDefinition[] {
  const article = defineTool<typeof articleParameters, ArticleDetails | ArticleOpenDetails>({
    name: "article",
    label: "Article",
    description:
      "Open, create and revise a long document (article, report, essay, draft) in the document panel. First call action=open with only title (new document) or id (revision), wait for its result, then write. Do not paste the document into the chat reply.",
    promptSnippet: "Write and revise long documents in the article panel instead of the chat",
    promptGuidelines: [
      "When the user wants a piece of writing they will read as a document, call article instead of putting the document in the chat reply.",
      "The chat reply is one or two sentences. The panel renders the file, shows each version's diff, and exports it.",
      "Before writing or revising, call article with action=open and only title (new document) or id (existing document). Wait for that tool result before generating content in a separate call. This opens the panel even when the API buffers tool arguments until the end; open does not save a version.",
      "create with title and the full markdown content. Revise with update on the same id: send content for a new full draft, or edits of {find, replace} for a local change. Each change is a new version.",
      "Build a long document through an outline and small section updates instead of one giant call. Some APIs deliver tool arguments only when complete, so each completed section is the next visible update. Keep action, id and title before content/edits in the arguments.",
      "Do not use the edit tool on the article files. read returns the current markdown when you need it again.",
    ],
    parameters: articleParameters,
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal) => {
      if (signal?.aborted) throw new Error("Article write aborted");
      if (params.action === "open") {
        if (params.content !== undefined || params.edits !== undefined || params.version !== undefined) {
          throw new Error("article open accepts only title or id; write content in the next create/update call");
        }
        const document = params.id ? await articles.read({ sessionId, id: params.id, limit: 1 }) : undefined;
        if (params.id && !document) throw new Error(`No article ${params.id} in this session.`);
        const title = document?.title ?? cleanTitle(required(params.title?.trim(), "article open requires title or id"));
        return {
          content: [{ type: "text", text: [
            document ? `article open ${document.id} version ${document.version}` : "article open",
            `标题：${title}`,
            "文稿面板已打开，尚未写入新版本。",
            document ? `Next: update ${document.id} in small sections.` : "Next: create with this title and a short outline, then update that id in small sections.",
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
