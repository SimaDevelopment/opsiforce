---
name: document-generation
description: Produce Word, PowerPoint, Excel, and PDF deliverables — reports, decks, spreadsheets, invoices, exports — with the libraries already installed in this container (docx, pptxgenjs, pdf-lib, openpyxl, reportlab, pypdf, pandoc, Chromium). Use whenever the user asks for a document, report, deck, presentation, slides, spreadsheet, workbook, or PDF, and when reading or revising one you already delivered.
---

# Document Generation — docx, pptx, xlsx, pdf

Everything below is **already installed in this container** — never reinstall any of it with `npm install`, `yarn add`, `pip install` or `apt-get install`.

| Need | Use | Version |
|---|---|---|
| Word (`.docx`) | `docx` (npm, JS) | 9.7.1 |
| PowerPoint (`.pptx`) | `pptxgenjs` (npm, JS) | 4.0.1 |
| Excel (`.xlsx`) | `openpyxl` (Python) | 3.1.5 |
| PDF, programmatic | `reportlab` (Python) | 5.0.1 |
| PDF, visually rich | Chromium `--headless --print-to-pdf` over your own HTML | system |
| PDF manipulation | `pypdf` (Python) or `pdf-lib` (npm) | 6.16.1 / 1.17.1 |
| Read an existing document | `pandoc`, `pdftotext`, `pdftoppm`, `openpyxl` | system |

The three npm packages resolve from **anywhere** in the filesystem — `require("docx")` works in a script at `/workspace/generators/invoice/gen.js` with no `package.json` and no install step. Keep generator scripts, layouts and the source material a revision would need under `/workspace/generators/<deliverable>/`, never loose at the workspace root (the root shows in the user's Files tab) and never in `/tmp`, which goes with the pod: a user who asks for the same report next month with two more columns needs the generator that made the first one. Intermediates nobody revises — a rendered HTML page on its way to PDF, a chart PNG — can stay in `/tmp`.

## Where the file goes

Every deliverable goes in `/workspace/generated_files/` and is shared as a link, as the `platform` skill says (§Files the user gives you, and files you give back). A turn that produced a document and does not end in its link is unfinished.

## Revising a document you already delivered

**Default to a versioned filename** — `report.docx` → `report_v2.docx` → `report_v3.docx` — so the link you posted earlier keeps opening the document it announced. **Overwrite the same file only when the user explicitly asks you to fix that file** (for example "fix the typo in that report", "update the same file"). When you write a new version, link the new file and say which version it is.

## Word — `docx`

```js
const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, convertInchesToTwip } = require("docx")
const fs = require("node:fs")

const doc = new Document({
  styles: {
    default: {
      document: { run: { font: "Liberation Sans", size: 22 } },
    },
  },
  sections: [{
    properties: {
      page: { margin: { top: convertInchesToTwip(1), right: convertInchesToTwip(1), bottom: convertInchesToTwip(1), left: convertInchesToTwip(1) } },
    },
    children: [
      new Paragraph({ text: "Q3 Revenue Review", heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER }),
      new Paragraph({ text: "Summary", heading: HeadingLevel.HEADING_1 }),
      new Paragraph({ children: [new TextRun("Revenue grew "), new TextRun({ text: "18%", bold: true }), new TextRun(" quarter over quarter.")] }),
    ],
  }],
})

Packer.toBuffer(doc).then((buffer) => fs.writeFileSync("/workspace/generated_files/Q3-report.docx", buffer))
```

`size` is half-points (`22` = 11pt). Build tables with `Table`/`TableRow`/`TableCell` and `WidthType.PERCENTAGE`, images with `ImageRun`.

**`docx` cannot open an existing .docx.** To change a document you generated, re-run the generator with the new content. To change a document the *user* uploaded, read it with `pandoc -f docx -t markdown file.docx`, then either regenerate it or unzip → patch `word/document.xml` → rezip.

## PowerPoint — `pptxgenjs`

```js
const PptxGenJS = require("pptxgenjs")
const pptx = new PptxGenJS()
pptx.layout = "LAYOUT_16x9"

const title = pptx.addSlide()
title.addText("Q3 Revenue Review", { x: 0.6, y: 2.3, w: 8.8, h: 1, fontSize: 40, bold: true, fontFace: "Liberation Sans" })
title.addText("Prepared for the leadership team · October 2026", { x: 0.6, y: 3.3, w: 8.8, h: 0.5, fontSize: 16, color: "666666" })

const slide = pptx.addSlide()
slide.addText("Revenue by region", { x: 0.6, y: 0.4, w: 8.8, h: 0.6, fontSize: 28, bold: true })
slide.addText(["EMEA up 22%", "AMER up 14%", "APAC flat"].map((t) => ({ text: t, options: { bullet: true } })), { x: 0.8, y: 1.4, w: 8.4, h: 3, fontSize: 18 })

pptx.writeFile({ fileName: "/workspace/generated_files/Q3-review.pptx" })
```

**Every deck opens with a title slide**: deck title, one supporting line (audience, date, or one-sentence takeaway), nothing else. After that, one idea per slide, at most six bullets, no paragraph dumped into a text box. Charts come from `slide.addChart(pptx.ChartType.bar, …)`, not screenshots.

## Excel — `openpyxl`

```python
from openpyxl import Workbook
from openpyxl.styles import Font
from openpyxl.utils import get_column_letter

wb = Workbook()
ws = wb.active
ws.title = "Revenue"
ws.append(["Region", "Q2", "Q3", "Growth"])
for cell in ws[1]:
    cell.font = Font(bold=True)
for row in [("EMEA", 120, 146), ("AMER", 210, 239), ("APAC", 88, 88)]:
    ws.append([*row, (row[2] - row[1]) / row[1]])
ws.freeze_panes = "A2"
for column in range(1, ws.max_column + 1):
    ws.column_dimensions[get_column_letter(column)].width = 14
wb.save("/workspace/generated_files/revenue.xlsx")
```

For several sheets, `wb.create_sheet("Name")`. **There is no pandas in this container** — write rows with `ws.append()` and stream large sets with `Workbook(write_only=True)` rather than reaching for a DataFrame.

**There is no LibreOffice in this container, so nothing recalculates formulas after you write them.** A formula string is stored uncalculated and shows a value only once the user opens the file in Excel — and shows nothing at all in the platform's in-app preview. Write **computed values** for anything the user needs to read, and add formulas only when the user asked for a working model.

## PDF — two paths

**Visually rich (reports, invoices, anything with a layout):** write HTML + CSS, print it with the system Chromium. You are better at CSS than at PDF coordinates.

```bash
chromium --headless --no-sandbox --disable-gpu --hide-scrollbars \
  --user-data-dir=/tmp/chrome-print --no-pdf-header-footer \
  --virtual-time-budget=10000 \
  --print-to-pdf=/workspace/generated_files/invoice.pdf file:///tmp/invoice.html
```

Set page geometry in the HTML (`@page { size: A4; margin: 20mm; }`), keep tables together with `break-inside: avoid`, and embed images as `data:` URIs or absolute `file:///` paths — the page is loaded from disk with no network.

**If you deliver an `.html` file instead of a PDF, inline everything.** The platform serves previewed HTML with `default-src 'none'`, so remote scripts, stylesheets, images, and any `fetch` are blocked. A report that pulls a chart library off a CDN renders broken in the preview panel and gives the user no clue why. Inline `<script>` and `<style>` still execute and `data:` images still draw, so build charts from data embedded in the page — or deliver a PDF, which is the better format for anything the user will keep.

**Programmatic (tabular, generated per record, thousands of pages):** `reportlab` Platypus.

```python
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import inch
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle

styles = getSampleStyleSheet()
doc = SimpleDocTemplate("/workspace/generated_files/summary.pdf", pagesize=A4,
                        topMargin=inch, bottomMargin=inch, leftMargin=inch, rightMargin=inch)
doc.build([
    Paragraph("Q3 Revenue Review", styles["Title"]),
    Spacer(1, 12),
    Table([["Region", "Q3"], ["EMEA", "146"], ["AMER", "239"]],
          style=TableStyle([("GRID", (0, 0), (-1, -1), 0.5, colors.grey), ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold")])),
])
```

To place an image, pass reportlab a plain filesystem path — `Image("/tmp/chart.png", width=180, height=120)`. It rejects `data:` and `file:` URIs unless `rl_config.trustedHosts` names the host, which is deliberate here and not worth working around.

**Manipulating an existing PDF** — merge, split, rotate, stamp, fill a form, extract text — is `pypdf` (Python) or `pdf-lib` (JS), never a regeneration. `pdftotext` reads one; `pdftoppm -png -r 80` renders a page to an image when you need to *look* at the result you produced.

## Fonts

The only font family installed is **Liberation** (Sans/Serif/Mono, at `/usr/share/fonts/truetype/liberation/`) — metric-compatible with Arial/Times/Courier, so it is the safe default for any document.

- docx and pptx: name the font (`"Liberation Sans"`); the reader substitutes its own metric-compatible face.
- Chromium: `font-family: "Liberation Sans", sans-serif`.
- reportlab: the built-in Helvetica/Times/Courier faces need no registration.

**This container has no CJK and no emoji fonts.** Chinese, Japanese, Korean, and emoji characters render as blank boxes in any PDF you produce — and, worse, silently: the generator reports success. So when the content needs them, say so instead of shipping a broken PDF. Deliver a docx or pptx instead (the reader supplies its own fonts) or ask the user whether they want the fonts added to the image. Latin, including accented Western European text, is fully covered.

## Common mistakes

1. **Overwriting a delivered file on a revision.** Default to `_v2`; the earlier chat link must keep resolving to what it announced.
2. **Shipping uncalculated spreadsheet formulas** as the answer — nothing recalculates them here. Write the computed values.
3. **Fighting reportlab for a pretty layout.** If it needs design, write HTML and print it with Chromium.
4. **Writing the generator anywhere but `/workspace/generators/<deliverable>/`.** A revision reuses the generator that made the original — same method, same conventions — and re-verifies the result the way the first run did.
5. **Reopening a generated .docx with `docx`.** It only writes. Regenerate, or patch the XML.
6. **Putting CJK or emoji in a PDF.** There are no fonts for them here and the failure is silent — blank boxes in a file that generated without error. Deliver docx/pptx instead, or tell the user.
