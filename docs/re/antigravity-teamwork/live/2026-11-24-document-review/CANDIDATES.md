# Synthesis Candidates — Index

Four Level-0 `teamwork_synthesizer` candidates were produced in parallel under `<state>/teamwork_group_synthesis/synthesis/` between 21:20:50Z and 21:21:45Z. The Level-1 reducer read all four plus all three segment unit reports and wrote `final_reduced_report.md`.

Only `candidate_1.md` is reproduced in this bundle. The other three are listed here with their source hashes and sizes; they are near-duplicates of one another and of the final report, so the bundle keeps one representative and records the set.

| Candidate | Source bytes | SHA-256 (source) | Bundled | Note |
|---|---:|---|---|---|
| `candidate_1.md` | 6,605 | `4c14338569c85409d8a13f8952c46ed7046853561c41aa03fbb4b1ecd8bea057` | yes (redacted) | Representative; its own `Segment Report References` table is the same three-path table as the final report |
| `candidate_2.md` | 6,050 | `46467cd7d0aba27d2a0c846ec171d5da2a0fb0107ca891d433c8d64c723d5680` | no | Cited by hash and size only |
| `candidate_3.md` | 5,649 | `eb7aa34f3edf711f22bb4f01b46d9f02693d6fbf9d2829d34fa452cf4155eaa8` | no | Cited by hash and size only |
| `candidate_4.md` | 6,815 | `d6862654fd16f5c18c303f99aa957dd13e01525344f72d063cc19878026e1bae` | no | Cited by hash and size only |
| `final_reduced_report.md` | 7,792 | `f76e512ff27e0839d27615fc2d5146435e229edd622e2a05f93e7a89abde5ff5` | as `DOCUMENT_REVIEW_REPORT.md` | Byte-identical to the delivered report before redaction |

The bundled `candidate_1.md` is redacted (absolute paths normalised), so its hash is in `MANIFEST.sha256` and differs from the source hash above. The source and delivered reports were compared with `cmp`: identical, 7,792 bytes, same SHA-256.
