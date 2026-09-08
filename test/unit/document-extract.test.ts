import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import { extractDocument, UnsupportedDocumentError } from "../../src/documents/extract.js";
import {
  buildCompoundFile,
  buildLegacyExcel,
  buildLegacyPowerPoint,
  buildLegacyWord,
  buildPdf,
  buildZip,
} from "../fixtures/documents.js";

const cleanups: string[] = [];

afterEach(async () => Promise.all(cleanups.splice(0).map(async (path) => rm(path, { recursive: true, force: true }))));

async function fixture(name: string, content: Buffer | string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pspore-documents-"));
  cleanups.push(directory);
  const path = join(directory, name);
  await writeFile(path, content);
  return path;
}

describe("document extraction", () => {
  test("reads a Word document as paragraphs, keeping tabs and entities", async () => {
    const path = await fixture("会议纪要.docx", buildZip([
      { name: "[Content_Types].xml", content: "<Types/>" },
      {
        name: "word/document.xml",
        content: "<w:document><w:body>"
          + "<w:p><w:r><w:t>江苏省分行金科部部务会议纪要</w:t></w:r></w:p>"
          + "<w:p><w:r><w:t>一、</w:t></w:r><w:r><w:tab/><w:t xml:space=\"preserve\">授信业务 </w:t></w:r><w:r><w:t>上线</w:t></w:r></w:p>"
          + "<w:p/>"
          + "<w:p><w:r><w:t>二、责任人 &amp; 分工 &lt;张三&gt;</w:t></w:r><w:br/><w:r><w:t>第二行</w:t></w:r></w:p>"
          + "</w:body></w:document>",
      },
    ]));

    const document = await extractDocument(path);
    assert.equal(document.format, "docx");
    // Runs inside one paragraph join without a break; the paragraph ends the line.
    assert.match(document.text, /^江苏省分行金科部部务会议纪要\n一、\t授信业务 上线/);
    assert.match(document.text, /二、责任人 & 分工 <张三>\n第二行$/);
  });

  test("reads a workbook through its shared string table, one section per sheet", async () => {
    const path = await fixture("报表.xlsx", buildZip([
      {
        name: "xl/workbook.xml",
        content: '<workbook><sheets><sheet name="会议纪要"/><sheet name="附录"/></sheets></workbook>',
      },
      {
        name: "xl/sharedStrings.xml",
        content: "<sst><si><t>项目</t></si><si><t>负责人</t></si><si><t>授信业务系统</t></si><si><t>张三</t></si><si><t>第二张表</t></si></sst>",
      },
      {
        name: "xl/worksheets/sheet1.xml",
        content: "<worksheet><sheetData>"
          + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>'
          + '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="s"><v>3</v></c><c r="C2"><v>1250000</v></c></row>'
          + '<row r="3"><c r="A3" t="inlineStr"><is><t>内联</t></is></c><c r="B3"><f>1+2</f><v>3</v></c></row>'
          + '<row r="4"><c r="A4"/><c r="B4"/></row>'
          + "</sheetData></worksheet>",
      },
      {
        name: "xl/worksheets/sheet2.xml",
        content: '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>4</v></c></row></sheetData></worksheet>',
      },
    ]));

    const document = await extractDocument(path);
    assert.equal(document.format, "xlsx");
    assert.deepEqual(document.sections.map((section) => section.name), ["会议纪要", "附录"]);
    assert.equal(document.sections[0]?.text.split("\n")[1], "授信业务系统\t张三\t1250000");
    // A formula reports the value the document shows, not the formula itself.
    assert.equal(document.sections[0]?.text.split("\n")[2], "内联\t3");
    // A row of empty cells carries nothing once the layout is gone.
    assert.equal(document.sections[0]?.text.split("\n").length, 3);
  });

  test("orders slides numerically rather than by name", async () => {
    const slide = (title: string): string =>
      `<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p>`
      + "<a:p><a:r><a:t>要点一</a:t></a:r><a:br/><a:r><a:t>要点二</a:t></a:r></a:p>"
      + "</p:txBody></p:sp></p:spTree></p:cSld></p:sld>";
    const path = await fixture("汇报.pptx", buildZip([
      { name: "ppt/presentation.xml", content: "<p:presentation/>" },
      { name: "ppt/slides/slide1.xml", content: slide("第一页") },
      { name: "ppt/slides/slide2.xml", content: slide("第二页") },
      // Sorted as text this would come second, which would misreport the deck.
      { name: "ppt/slides/slide10.xml", content: slide("第十页") },
    ]));

    const document = await extractDocument(path);
    assert.equal(document.format, "pptx");
    assert.deepEqual(document.sections.map((section) => section.text.split("\n")[0]), ["第一页", "第二页", "第十页"]);
    assert.equal(document.sections[0]?.text, "第一页\n要点一\n要点二");
  });

  test("follows the piece table of a Word 97 document instead of reading the stream", async () => {
    const path = await fixture("纪要.doc", buildLegacyWord(
      "江苏省分行金科部部务会议纪要\r一、\t授信业务系统上线进度\rASCII stays readable\r",
    ));
    const document = await extractDocument(path);
    assert.equal(document.format, "doc");
    assert.equal(document.formatLabel, "Word 97-2003 文档");
    assert.equal(
      document.text,
      "江苏省分行金科部部务会议纪要\n一、\t授信业务系统上线进度\nASCII stays readable",
    );
  });

  test("reads an Excel 97 workbook, resolving cells through the shared string table", async () => {
    const path = await fixture("台账.xls", buildLegacyExcel("会议纪要", [
      ["项目", "负责人", "金额"],
      ["授信业务系统", "张三", 1_250_000],
      ["风控中台", "李四", 880.5],
    ]));
    const document = await extractDocument(path);
    assert.equal(document.format, "xls");
    assert.deepEqual(document.sections.map((section) => section.name), ["会议纪要"]);
    assert.equal(
      document.sections[0]?.text,
      "项目\t负责人\t金额\n授信业务系统\t张三\t1250000\n风控中台\t李四\t880.5",
    );
  });

  test("splits a PowerPoint 97 deck on its slide records", async () => {
    const path = await fixture("汇报.ppt", buildLegacyPowerPoint([
      ["第一页标题", "要点一\r要点二"],
      ["第二页标题", "结论"],
    ]));
    const document = await extractDocument(path);
    assert.equal(document.format, "ppt");
    assert.deepEqual(document.sections.map((section) => section.name), ["幻灯片 1", "幻灯片 2"]);
    assert.equal(document.sections[0]?.text, "第一页标题\n要点一\n要点二");
  });

  test("reads a PDF page by page", async () => {
    const path = await fixture("report.pdf", buildPdf(["Meeting minutes 2026", "Credit business review"]));
    const document = await extractDocument(path);
    assert.equal(document.format, "pdf");
    assert.deepEqual(document.sections.map((section) => section.name), ["第 1 页"]);
    assert.match(document.sections[0]?.text ?? "", /Meeting minutes 2026/);
    assert.match(document.sections[0]?.text ?? "", /Credit business review/);
  });

  test("decodes a legacy Chinese text file rather than reporting it as corrupt", async () => {
    // A plain-text file written on Windows or by WPS is routinely GB18030, and
    // decoding one as UTF-8 turns every character into a replacement mark.
    const path = await fixture("说明.txt", Buffer.from(
      new TextEncoder().encode("placeholder"),
    ));
    await writeFile(path, gb18030("江苏省分行\n授信业务系统\n"));
    const document = await extractDocument(path);
    assert.equal(document.format, "text");
    assert.equal(document.encoding, "gb18030");
    assert.equal(document.text, "江苏省分行\n授信业务系统\n");

    const utf8 = await fixture("说明.md", "# 标题\n正文\n");
    assert.equal((await extractDocument(utf8)).encoding, "utf-8");
    const bom = await fixture("bom.txt", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("带 BOM", "utf8")]));
    assert.equal((await extractDocument(bom)).text, "带 BOM");
  });

  test("decides the format from the bytes, not the extension", async () => {
    // WPS and mail attachments routinely disagree with the extension, and a
    // document renamed to .txt is still a document.
    const path = await fixture("会议纪要.txt", buildZip([
      { name: "word/document.xml", content: "<w:document><w:body><w:p><w:r><w:t>其实是 Word</w:t></w:r></w:p></w:body></w:document>" },
    ]));
    const document = await extractDocument(path);
    assert.equal(document.format, "docx");
    assert.equal(document.text, "其实是 Word");
  });

  test("says what an unreadable file is instead of returning its wreckage", async () => {
    // A compound document that is not one of the three Microsoft formats: this
    // is where WPS's own .wps/.et/.dps land.
    const wps = await fixture("文稿.wps", buildCompoundFile([
      { name: "WpsCustomData", content: Buffer.from("kingsoft") },
    ]));
    await assert.rejects(extractDocument(wps), (error: unknown) => {
      assert.ok(error instanceof UnsupportedDocumentError);
      assert.match(error.message, /另存为/);
      return true;
    });

    const zip = await fixture("bundle.zip", buildZip([{ name: "readme.txt", content: "not office" }]));
    await assert.rejects(extractDocument(zip), /不是 Word\/Excel\/PowerPoint 文档/);

    const binary = await fixture("blob.bin", Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0x7f, 0x10]));
    await assert.rejects(extractDocument(binary), /无法识别的二进制格式/);
  });

  test("refuses a file past the size ceiling before reading it into memory", async () => {
    const path = await fixture("big.txt", "x".repeat(4_096));
    await assert.rejects(extractDocument(path, { maxBytes: 1_024 }), /超过 1024 字节的抽取上限/);
  });

  test("reports how much text a cut document had", async () => {
    const path = await fixture("long.txt", "字".repeat(5_000));
    const document = await extractDocument(path, { limit: 100 });
    assert.equal(document.text.length, 100);
    assert.equal(document.truncatedFrom, 5_000);
    // A per-section breakdown that disagreed with the text above it would be
    // worse than none at all.
    assert.deepEqual(document.sections, []);
  });
});

function gb18030(value: string): Buffer {
  // Node can decode GB18030 but not encode it, so the fixture is written from
  // the code points the test cares about.
  const table: Record<string, number[]> = {
    江: [0xbd, 0xad], 苏: [0xcb, 0xd5], 省: [0xca, 0xa1], 分: [0xb7, 0xd6], 行: [0xd0, 0xd0],
    授: [0xca, 0xda], 信: [0xd0, 0xc5], 业: [0xd2, 0xb5], 务: [0xce, 0xf1], 系: [0xcf, 0xb5],
    统: [0xcd, 0xb3],
  };
  const bytes: number[] = [];
  for (const character of value) {
    const encoded = table[character];
    if (encoded) bytes.push(...encoded);
    else bytes.push(character.charCodeAt(0));
  }
  return Buffer.from(bytes);
}
