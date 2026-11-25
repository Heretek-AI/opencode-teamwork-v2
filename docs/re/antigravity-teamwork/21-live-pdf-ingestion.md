# 21 — PDF Ingestion Run (Corpus Record, Issue #48)

**Date:** 2026-11-25  
**Host:** Linux workstation (`python3`, `node` 24, `bun` 1.4.4)  
**Evidence discipline:** Every finding below is strictly labeled `OBSERVED`, `INFERRED`, or `UNKNOWN`. No generalization is drawn from a single run.

---

## 1. Pre-flight dependency probe

| Dependency | Status | Evidence |
| --- | --- | --- |
| `pypdfium2` | **OBSERVED: MISSING** (`No module named 'pypdfium2'`) | `python3 -c 'import pypdfium2'` |
| `Pillow` (`PIL`) | **OBSERVED: MISSING** (`No module named 'PIL'`) | `python3 -c 'import PIL'` |

## 2. Fixture

- Generated minimal 3-page PDF (`sample-3page.pdf`, `/Count 3`, `/MediaBox [0 0 612 792]`).

## 3. Observations

- **OBSERVED:** On this host without `pypdfium2` and `Pillow`, image-rendering pre-flight cannot render PDF pages into `page_image_dir`.
- **OBSERVED:** Local `plugins/opencode-teamwork/document-review.ts` exports `ingestDocument`, `resolveAndReadDocument`, `segmentDocument`, `classifyRoute`, and `MAX_PDF_INFLATE_BYTES` (pure JS inflate path without Python dependencies).
- **UNKNOWN:** Exact Antigravity upstream `teamwork_ingestor` invocation path, `page_image_dir` layout, `pypdfium2`/`Pillow` pre-flight table row wording, and `DOCUMENT_TEXT_MAP.md` format when `pypdfium2` + `Pillow` are installed in an Antigravity runtime. Re-run once `pypdfium2` and `Pillow` are installed in a live Antigravity session to close these remaining `UNKNOWN` cells.
