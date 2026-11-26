# 21 — PDF Ingestion Run (Corpus Record, Issue #48)

**Date:** 2026-11-26 (updated from 2026-11-25 baseline)  
**Host:** Linux workstation (`python3` 3.15.2, `node` 24, `bun` 1.4.4, `agy` 1.5.18 SHA-256 `7c96ad8c944c1a8d195ca34d2041a3d74d5166c96662b52183b748a3c455d52f`)  
**Evidence discipline:** Every finding below is strictly labeled `OBSERVED`, `INFERRED`, or `UNKNOWN`. No generalization is drawn from a single run.

---

## 1. Pre-flight dependency probe

| Environment | Dependency | Status | Evidence |
| --- | --- | --- | --- |
| System `python3` | `pypdfium2` / `Pillow` | **OBSERVED: MISSING** | `python3 -c 'import pypdfium2, PIL'` (`No module named 'pypdfium2'`) |
| Isolated venv (`/tmp/tw-pdf-venv`) | `pypdfium2==5.15.2`, `pillow==13.0.0` | **OBSERVED: READY** | `uv pip install pypdfium2 Pillow`; opened 3-page PDF (`len(doc) == 3`, page 1 text length `171`) |

## 2. Fixture

- Generated digital 3-page PDF (`/tmp/tw-corpus-48/sample-3page.pdf`, `/Count 3`, `/MediaBox [0 0 612 792]`, ≥ 150 chars per page across Introduction, Methodology, Evaluation).

## 3. Observations

- **OBSERVED (`agy` 1.5.18 static binary contract):** The embedded `document_ingestor` prompt (`agy` 1.5.18 offset `115,170,004`–`115,173,686`) writes `scratch/ingest_document_pdfium.py`, renders `page-{i+1}.png` at `200 DPI` (`scale = 200/72.0`) via `pypdfium2` + `PIL`, refuses scanned PDFs (`avg_len < 50`), and emits `DOCUMENT_TEXT_MAP.md` with `## [Page N] (\`page-N.png\`)` headings plus `Text map:` and `Page images:` stdout lines.
- **OBSERVED (`agy` 1.5.18 print mode):** Running `PATH="/tmp/tw-pdf-venv/bin:$PATH" agy -p "/teamwork [skip-interview] Critique the supplied PDF document /tmp/tw-corpus-48/sample-3page.pdf using Document Review." --output-format stream-json --dangerously-skip-permissions` (conversation `13e323ac-f8fd-437a-9f20-429bf85750f9`) dispatched `invoke_subagent({ type_name: "teamwork", role: "Document Review Team" })` and exited print mode (`status: "SUCCESS"`, exit 0) upon handing off to the background sentinel subagent. Because print mode exits once the parent turn completes, the background sentinel did not complete downstream `teamwork_ingestor` execution in headless print mode (consistent with `18-live-document-review.md` §2, which required an interactive TUI session).
- **OBSERVED (`opencode-teamwork-v2` 0.20.0 with real `pypdfium2==5.15.2` + `Pillow==13.0.0`):** `renderPdfPageImages(buf, { dpi: 150 })` on `sample-3page.pdf` succeeded and produced 3 bounded PNGs (`page-1.png` `1275x1651` `28,184 B`, `page-2.png` `1275x1651` `29,051 B`, `page-3.png` `1275x1651` `26,129 B`; `totalBytes = 83,364`).
- **UNKNOWN:** Exact runtime `page_image_dir` path and `pypdfium2`/`Pillow` pre-flight table wording produced inside an interactive `agy` TUI session when `teamwork_ingestor` runs to completion.
