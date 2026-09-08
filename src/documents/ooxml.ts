import { ZipArchive } from "./zip.js";

/**
 * Text out of Office Open XML packages: `.docx`, `.xlsx` and `.pptx`, plus
 * anything WPS wrote in the same containers under a different extension.
 *
 * These are read with a scanner rather than a DOM: only character data and a
 * handful of break elements matter, the parts are machine-generated, and a
 * general XML parser would be a dependency handling untrusted documents.
 */

export type OoxmlKind = "docx" | "xlsx" | "pptx";

export interface OoxmlDocument {
  kind: OoxmlKind;
  text: string;
  /** One entry per worksheet or slide; empty for a word-processing document. */
  sections: readonly { name: string; text: string }[];
}

/** Which OOXML format a package holds, decided by the parts it carries. */
export function detectOoxmlKind(archive: ZipArchive): OoxmlKind | undefined {
  if (archive.has("word/document.xml")) return "docx";
  if (archive.has("xl/workbook.xml")) return "xlsx";
  if (archive.has("ppt/presentation.xml")) return "pptx";
  return undefined;
}

export function extractOoxml(archive: ZipArchive, kind: OoxmlKind): OoxmlDocument {
  if (kind === "docx") return { kind, text: extractWord(archive), sections: [] };
  if (kind === "pptx") return extractSlides(archive);
  return extractSheets(archive);
}

/**
 * Word body text. Paragraphs end a line, `w:tab` and `w:br` keep the breaks the
 * author typed, and everything else is markup the reader does not need.
 */
function extractWord(archive: ZipArchive): string {
  const xml = archive.readText("word/document.xml") ?? "";
  return collapseBlankLines(harvestText(xml, {
    text: /^w:t$/,
    lineBreak: /^w:(?:br|cr)$/,
    tab: /^w:tab$/,
    paragraph: /^w:p$/,
  }));
}

/**
 * Slide text in slide order, with each slide named so a reader can cite one.
 * Speaker notes are deliberately left out: they are not what is on the slide.
 */
function extractSlides(archive: ZipArchive): OoxmlDocument {
  const sections = archive.matching(/^ppt\/slides\/slide\d+\.xml$/).map((part, index) => ({
    name: `幻灯片 ${index + 1}`,
    text: collapseBlankLines(harvestText(archive.readText(part) ?? "", {
      text: /^a:t$/,
      lineBreak: /^a:br$/,
      tab: /^a:tab$/,
      paragraph: /^a:p$/,
    })),
  }));
  return { kind: "pptx", sections, text: joinSections(sections) };
}

/**
 * Worksheet cells as tab-separated rows, which keeps a table readable without
 * inventing a layout. Values live in the shared string table often enough that
 * a sheet read on its own would come back as a page of integers.
 */
function extractSheets(archive: ZipArchive): OoxmlDocument {
  const sharedStrings = readSharedStrings(archive);
  const names = readSheetNames(archive);
  const parts = archive.matching(/^xl\/worksheets\/sheet\d+\.xml$/);
  const sections = parts.map((part, index) => ({
    name: names[index] ?? `工作表 ${index + 1}`,
    text: readSheet(archive.readText(part) ?? "", sharedStrings),
  }));
  return { kind: "xlsx", sections, text: joinSections(sections) };
}

function readSharedStrings(archive: ZipArchive): string[] {
  const xml = archive.readText("xl/sharedStrings.xml");
  if (xml === undefined) return [];
  // Each <si> is one string, possibly split across runs that only differ in
  // formatting, so the runs inside one entry are concatenated without a break.
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)]
    .map((match) => harvestText(match[1] ?? "", { text: /^t$/ }).replace(/\n/g, ""));
}

function readSheetNames(archive: ZipArchive): string[] {
  const xml = archive.readText("xl/workbook.xml") ?? "";
  return [...xml.matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((match) => decodeEntities(match[1] ?? ""));
}

function readSheet(xml: string, sharedStrings: readonly string[]): string {
  const lines: string[] = [];
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const cellMatch of (rowMatch[1] ?? "").matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      cells.push(readCell(cellMatch[1] ?? "", cellMatch[2] ?? "", sharedStrings));
    }
    // A row of empty cells carries no information once the layout is gone.
    if (cells.some((cell) => cell !== "")) lines.push(cells.join("\t"));
  }
  return lines.join("\n");
}

function readCell(attributes: string, body: string, sharedStrings: readonly string[]): string {
  const type = /\bt="([^"]*)"/.exec(attributes)?.[1];
  if (type === "s") {
    const index = Number(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? Number.NaN);
    return Number.isInteger(index) ? sharedStrings[index] ?? "" : "";
  }
  if (type === "inlineStr") return harvestText(body, { text: /^t$/ }).replace(/\n/g, "");
  // A formula cell keeps its cached result: the formula itself is not the value
  // the document is showing anyone.
  return decodeEntities(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "").trim();
}

interface HarvestRules {
  /** Elements whose character data is the document's text. */
  text: RegExp;
  lineBreak?: RegExp;
  tab?: RegExp;
  /** Elements that end a line when they close. */
  paragraph?: RegExp;
}

/**
 * Walks the markup once, emitting character data from the elements that carry
 * text and a break wherever the format says a line ends.
 *
 * Written as a scanner because these parts are large, machine-generated and
 * untrusted: it never builds a tree, so a deeply nested document costs no more
 * than a flat one.
 */
function harvestText(xml: string, rules: HarvestRules): string {
  let out = "";
  let cursor = 0;
  let capturing = 0;
  while (cursor < xml.length) {
    const open = xml.indexOf("<", cursor);
    if (open < 0) break;
    if (capturing > 0 && open > cursor) out += decodeEntities(xml.slice(cursor, open));
    const close = xml.indexOf(">", open);
    if (close < 0) break;
    const tag = xml.slice(open + 1, close);
    cursor = close + 1;
    // Comments, CDATA, processing instructions and doctypes carry no text.
    if (tag.startsWith("!") || tag.startsWith("?")) continue;

    const selfClosing = tag.endsWith("/");
    const closing = tag.startsWith("/");
    const name = elementName(tag);
    // A break is written either way round: `<w:br/>` and `<w:br></w:br>` are the
    // same instruction, and only one of them may appear in a given document.
    if (selfClosing || closing) {
      if (rules.lineBreak?.test(name)) out += "\n";
      else if (rules.tab?.test(name)) out += "\t";
    }
    if (selfClosing) {
      // An empty paragraph is written `<w:p/>`, and it is still a blank line.
      if (rules.paragraph?.test(name)) out += "\n";
      continue;
    }
    if (closing) {
      if (rules.text.test(name) && capturing > 0) capturing -= 1;
      if (rules.paragraph?.test(name)) out += "\n";
      continue;
    }
    if (rules.text.test(name)) capturing += 1;
  }
  return out;
}

function elementName(tag: string): string {
  const body = tag.replace(/^\//, "").replace(/\/$/, "").trim();
  const end = body.search(/[\s/]/);
  return end < 0 ? body : body.slice(0, end);
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeEntities(value: string): string {
  if (!value.includes("&")) return value;
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const code = entity.startsWith("#x") || entity.startsWith("#X")
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      // A reference outside Unicode, or to a lone surrogate, stays as written
      // rather than becoming a character no reader asked for.
      if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return match;
      if (code >= 0xd800 && code <= 0xdfff) return match;
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[entity] ?? match;
  });
}

function joinSections(sections: readonly { name: string; text: string }[]): string {
  return sections
    .filter((section) => section.text.trim() !== "")
    .map((section) => `## ${section.name}\n${section.text}`)
    .join("\n\n");
}

/** Office writes a paragraph per line break, so runs of empty ones pile up. */
function collapseBlankLines(value: string): string {
  return value.replace(/\n{3,}/g, "\n\n").trim();
}
