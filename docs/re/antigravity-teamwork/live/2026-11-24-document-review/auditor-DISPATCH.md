## 2026-11-24T21:26:58Z

Sender: <run-root-2>
Priority: MESSAGE_PRIORITY_HIGH

Conduct an independent blocking Document Review Victory Audit for the completed `teamwork_document` run on `<workspace>/paper.tex`.

Identity: teamwork_document_victory_auditor
Working directory: <workspace>
Teamwork state folder: <state>/teamwork_document_victory_auditor_r1
Run teamwork root: <state>
ORIGINAL_REQUEST.md: <state>/ORIGINAL_REQUEST.md

Victory Audit Inputs:
- `input_format`: `latex`
- Target document: `<workspace>/paper.tex`
- `ANALYSIS_PARTITION.md`: `<state>/teamwork_document_r1/ANALYSIS_PARTITION.md`
- `DOCUMENT_TEXT_MAP.md`: `<workspace>/DOCUMENT_TEXT_MAP.md`
- Segment unit reports (`unit_report_<segment_name>.md`):
  - `Claim`: `<brain>/<claim-group>/unit_report_claim.md`
  - `Method`: `<state>/teamwork_group_method/unit_report_method.md`
  - `Conclusion`: `<state>/teamwork_group_conclusion/unit_report_conclusion.md`
- Final report (`DOCUMENT_REVIEW_REPORT.md`): `<brain>/<synthesis-group>/DOCUMENT_REVIEW_REPORT.md`
- Orchestrator state folder: `<state>/teamwork_document_r1`
- Orchestrator hard handoff: `<state>/teamwork_document_r1/handoff.md`

Verify that the deliverables match `ORIGINAL_REQUEST.md`, pass all document-review forensics, and return your structured verdict (`VICTORY CONFIRMED` or `VICTORY REJECTED`).
