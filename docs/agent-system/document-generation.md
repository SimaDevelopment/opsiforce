---
kind: explanation
---

# Document Generation

> How does the Agent produce Word, PowerPoint, Excel and PDF deliverables, and how do they reach the member?

## How it works

### The stack in the image

- Every library is installed at image build time and nothing is installed at runtime, so generation works without registry access.
- Word and PowerPoint are JavaScript (`docx`, `pptxgenjs`) installed under `/opt/doc-tools` and exposed through a root `node_modules` symlink, so a throwaway script resolves them without a `package.json`; the App's own dependencies resolve through Yarn PnP and are untouched.
- Excel is Python `openpyxl`, with formatting, formulas and multiple sheets; there is no `pandas`.
- PDF has two paths: HTML and CSS printed by the Chromium already in the image for designed output, and `reportlab` for programmatic and tabular output; `pypdf` and `pdf-lib` manipulate existing PDFs.
- Reading is a separate toolchain: `pandoc` converts docx to markdown and `poppler-utils` provides `pdftotext` and `pdftoppm`, the latter being how the Agent looks at a PDF it produced.
- `fonts-liberation` and `fontconfig` are installed because the base image ships no fonts; CJK and emoji fonts are not installed, and there is no LibreOffice, so nothing recalculates spreadsheet formulas and the Agent cannot visually check Word or PowerPoint output.

### The skill and the convention

- One shared skill, `document-generation`, covers all four formats; it opens with the inventory of what is preinstalled and an instruction never to install any of it, then carries the recipes and a few taste defaults (Liberation body font, one-inch margins, a title slide first).
- Each Agent's `agent.md` carries two lines in its file-handling section: save deliverables under `/workspace/generated_files/`, and load `document-generation` for any docx, pptx, xlsx or pdf deliverable.
- Deliverables go into `/workspace/generated_files/`, created on first write, which [Files](../projects/files.md) surfaces as [Generated files](../../CONTEXT.md) and chat renders as file cards; the save-and-link convention is the only signal ([File Downloads](../projects/file-downloads.md)).
- Revisions default to versioned filenames (`report.docx`, then `report_v2.docx`), so a link already in the transcript keeps pointing at the document it announced; the Agent overwrites only when asked to fix that file.
- The libraries live in the image, so the capability reached existing workspaces through an empty `requiresPodRecreate` migration alongside the image-version bump, while the skill and prompt travelled as agent-owned files ([Agent Updates](agent-updates.md)).

## Edge cases

- When a PDF contains non-Latin text, it renders as blank boxes and the generator reports success; the skill tells the Agent to deliver docx or pptx instead or say what it cannot do.
- When a spreadsheet needs values the member will read, the Agent writes computed values, since no formula engine runs after the write.
- Preview conversion of Word and PowerPoint runs backend-side on a converter the Agent cannot reach and is unaffected by the missing LibreOffice ([File preview](../projects/file-preview.md)).

## Code

- `docker/Dockerfile.agent` — the baked libraries, fonts and toolchains.
- `agent-config/skills/document-generation/SKILL.md` — the recipes, inventory and conventions.
- `agent-config/agents/app-builder/agent.md` — the two pointer lines.

## Related

- [Agent](agent.md) — the profile the skill and prompt belong to.
- [Agent Updates](agent-updates.md) — the pipeline that carried the skill and the recreate.
- [Files](../projects/files.md) — the Generated files section.
- [File preview](../projects/file-preview.md) — how a deliverable is read in the panel.
