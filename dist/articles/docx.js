/**
 * Markdown to a WordprocessingML package.
 *
 * Headings, emphasis, lists, tables, quotes and code keep their roles as
 * styles and runs, so Word and WPS open a formatted document rather than a
 * dump of markdown source. No production dependency: the package is a ZIP of
 * XML, written with the same reader the document extractor already trusts.
 */
import { parseMarkdown, } from "../ui/shared/markdown.js";
import { writeZip } from "./zip-write.js";
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const CT = "http://schemas.openxmlformats.org/package/2006/content-types";
export function markdownToDocx(source, title) {
    const links = [];
    const body = parseMarkdown(source).map((block) => blockToWord(block, links, 0)).join("");
    const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}" xmlns:r="${R}">
  <w:body>
    ${body}
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/>
    </w:sectPr>
  </w:body>
</w:document>`;
    const hyperlinks = links.map((href, index) => {
        const id = index + 3;
        return `<Relationship Id="rId${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${escapeXml(href)}" TargetMode="External"/>`;
    }).join("");
    return writeZip([
        { name: "[Content_Types].xml", data: contentTypes() },
        { name: "_rels/.rels", data: rootRels() },
        { name: "docProps/core.xml", data: coreProps(title) },
        { name: "word/document.xml", data: document },
        { name: "word/styles.xml", data: styles() },
        { name: "word/numbering.xml", data: numbering() },
        {
            name: "word/_rels/document.xml.rels",
            data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${REL}">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
  ${hyperlinks}
</Relationships>`,
        },
    ]);
}
function blockToWord(block, links, depth) {
    switch (block.kind) {
        case "paragraph":
            return paragraph(inlineToWord(block.inline, links));
        case "heading":
            return paragraph(inlineToWord(block.inline, links), `Heading${block.level}`);
        case "code":
            return block.value.split("\n").map((line) => paragraph(`<w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="宋体"/><w:sz w:val="21"/></w:rPr><w:t xml:space="preserve">${escapeXml(line.length === 0 ? " " : line)}</w:t></w:r>`, "Code")).join("");
        case "quote":
            return block.blocks.map((child) => {
                if (child.kind === "paragraph")
                    return paragraph(inlineToWord(child.inline, links), "Quote");
                return blockToWord(child, links, depth);
            }).join("");
        case "list":
            return block.items.map((item) => {
                const head = item.blocks[0];
                const runs = head?.kind === "paragraph" ? inlineToWord(head.inline, links) : "";
                const mark = item.checked === undefined ? "" : item.checked ? "☑ " : "☐ ";
                const prefix = mark ? `<w:r><w:t xml:space="preserve">${mark}</w:t></w:r>` : "";
                const numId = block.ordered ? 2 : 1;
                const first = paragraph(`${prefix}${runs}`, undefined, { ilvl: Math.min(depth, LIST_LEVELS - 1), numId });
                const rest = item.blocks.slice(head?.kind === "paragraph" ? 1 : 0).map((child) => blockToWord(child, links, depth + 1)).join("");
                return `${first}${rest}`;
            }).join("");
        case "rule":
            return `<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="D6D3D1"/></w:pBdr></w:pPr></w:p>`;
        case "table": {
            const rows = [block.head, ...block.rows].map((row, rowIndex) => {
                const cells = row.map((cell) => `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>${paragraph(inlineToWord(cell, links), rowIndex === 0 ? "TableHead" : undefined)}</w:tc>`).join("");
                return `<w:tr>${cells}</w:tr>`;
            }).join("");
            return `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="D6D3D1"/><w:left w:val="single" w:sz="4" w:color="D6D3D1"/><w:bottom w:val="single" w:sz="4" w:color="D6D3D1"/><w:right w:val="single" w:sz="4" w:color="D6D3D1"/><w:insideH w:val="single" w:sz="4" w:color="D6D3D1"/><w:insideV w:val="single" w:sz="4" w:color="D6D3D1"/></w:tblBorders></w:tblPr>${rows}</w:tbl>`;
        }
    }
}
function paragraph(runs, style, numbering) {
    const styleXml = style ? `<w:pStyle w:val="${style}"/>` : "";
    const numXml = numbering ? `<w:numPr><w:ilvl w:val="${numbering.ilvl}"/><w:numId w:val="${numbering.numId}"/></w:numPr>` : "";
    const props = styleXml || numXml ? `<w:pPr>${styleXml}${numXml}</w:pPr>` : "";
    return `<w:p>${props}${runs}</w:p>`;
}
function inlineToWord(inline, links) {
    return inline.map((part) => inlinePart(part, links)).join("");
}
function inlinePart(part, links) {
    switch (part.kind) {
        case "text":
            return run(part.value);
        case "code":
            return run(part.value, "<w:rFonts w:ascii=\"Consolas\" w:hAnsi=\"Consolas\" w:eastAsia=\"宋体\"/><w:shd w:val=\"clear\" w:fill=\"F5F5F4\"/>");
        case "strong":
            return wrap(part.children, links, "<w:b/>");
        case "emphasis":
            return wrap(part.children, links, "<w:i/>");
        case "strike":
            return wrap(part.children, links, "<w:strike/>");
        case "link": {
            const href = /^https?:\/\//i.test(part.href) || /^mailto:/i.test(part.href) ? part.href : undefined;
            const inner = part.children.length > 0 ? wrap(part.children, links, "<w:color w:val=\"1D4E89\"/><w:u w:val=\"single\"/>") : run(part.href, "<w:color w:val=\"1D4E89\"/><w:u w:val=\"single\"/>");
            if (!href)
                return inner;
            links.push(href);
            return `<w:hyperlink r:id="rId${links.length + 2}">${inner}</w:hyperlink>`;
        }
        case "break":
            return "<w:r><w:br/></w:r>";
    }
}
function wrap(children, links, props) {
    return children.map((child) => {
        if (child.kind === "text" || child.kind === "code")
            return run(child.value, props);
        if (child.kind === "strong" || child.kind === "emphasis" || child.kind === "strike") {
            const extra = child.kind === "strong" ? "<w:b/>" : child.kind === "emphasis" ? "<w:i/>" : "<w:strike/>";
            return wrap(child.children, links, `${props}${extra}`);
        }
        return inlinePart(child, links);
    }).join("");
}
function run(value, props = "") {
    const safe = escapeXml(value);
    if (!safe)
        return "";
    const rPr = props ? `<w:rPr>${props}</w:rPr>` : "";
    return `<w:r>${rPr}<w:t xml:space="preserve">${safe}</w:t></w:r>`;
}
function escapeXml(value) {
    return [...value].filter((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code === 0x9 || code === 0xa || code === 0xd || code >= 0x20;
    }).join("")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}
function contentTypes() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="${CT}">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`;
}
function rootRels() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${REL}">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`;
}
function coreProps(title) {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:title>${escapeXml(title)}</dc:title>
  <dc:creator>pSpore</dc:creator>
</cp:coreProperties>`;
}
/**
 * Font names travel with the file, not the glyphs. The names picked here are the
 * ones present where these documents are opened: Calibri and Consolas on
 * Windows Word, 宋体 for Chinese on every Windows and WPS install. A Linux
 * reader substitutes through fontconfig, so the document still renders.
 */
function styles() {
    const heading = (level, size) => `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:qFormat/><w:rPr><w:b/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`;
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W}">
  <w:docDefaults><w:rPrDefault><w:rPr>
    <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="宋体" w:cs="Calibri"/>
    <w:sz w:val="22"/><w:szCs w:val="22"/>
    <w:lang w:val="en-US" w:eastAsia="zh-CN"/>
  </w:rPr></w:rPrDefault></w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
  ${[1, 2, 3, 4, 5, 6].map((level) => heading(level, level === 1 ? 36 : level === 2 ? 32 : level === 3 ? 28 : 24)).join("")}
  <w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="360"/></w:pPr><w:rPr><w:i/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:shd w:val="clear" w:fill="F5F5F4"/></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="TableHead"><w:name w:val="Table heading"/><w:basedOn w:val="Normal"/><w:rPr><w:b/></w:rPr></w:style>
</w:styles>`;
}
/** Nesting depth a list can reach before deeper items reuse the last level. */
const LIST_LEVELS = 9;
const BULLET_GLYPHS = ["\u2022", "\u25e6", "\u25aa"];
const ORDERED_FORMATS = ["decimal", "lowerLetter", "lowerRoman"];
/**
 * Word draws a list item at the level its `ilvl` names, and an `ilvl` the
 * numbering part never defines gets no indent and no glyph — which is how a
 * nested list ends up flattened to the left margin. Every level a document can
 * reach is therefore declared here, each with its own counter and indent.
 */
function numbering() {
    const levels = (ordered) => Array.from({ length: LIST_LEVELS }, (_unused, depth) => {
        const format = ordered ? ORDERED_FORMATS[depth % ORDERED_FORMATS.length] : "bullet";
        const text = ordered ? `%${depth + 1}.` : BULLET_GLYPHS[depth % BULLET_GLYPHS.length];
        const indent = 720 * (depth + 1);
        return `<w:lvl w:ilvl="${depth}"><w:start w:val="1"/><w:numFmt w:val="${format}"/><w:lvlText w:val="${escapeXml(text ?? "\u2022")}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${indent}" w:hanging="360"/></w:pPr></w:lvl>`;
    }).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="${W}">
  <w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${levels(false)}</w:abstractNum>
  <w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${levels(true)}</w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
  <w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`;
}
//# sourceMappingURL=docx.js.map