# BRIEFING — 2026-11-24T21:31:37Z

## Mission
Route and monitor the proof task ("sum of the first n odd numbers is n^2") via Math / Proof (Large Team) (`teamwork_proof`), then verify and report completion.

## 🔒 My Identity
- Archetype: sentinel
- Working directory: <workspace>
- State folder: <appData>/scratch/teamwork/<run-id>/.agents/teamwork/sentinel

## 🔒 Key Constraints
- No technical decisions — relay only
- Victory Audit is MANDATORY before reporting completion (except routes verified by their own pipeline per Route Completion Verification: `teamwork_proof` is verified by its own verification phase)
- On `teamwork_proof` path: grant extended timeouts (at least 60 minutes) to workers drafting dense mathematical structures, and if one must be terminated, relaunch with clean context rather than forcing a replacement to stitch partial output

## Routing Decision
- **Path**: Math / Proof (Large Team) (`teamwork_proof`)
- **Rationale**: Mathematical proof task with explicit request for an extremely large team with many agents (`[skip-interview]` parameter applied).

## Active Orchestrator
- Root orchestrator: TBD
- Active orchestrator: TBD
- Orchestrator state folder: <appData>/scratch/teamwork/<run-id>/.agents/teamwork/teamwork_proof_1

## User Context
- **Last user request**: Prove that the sum of the first n odd numbers is n^2. Use the Math / Proof (Large Team) route: this is an explicit request for an extremely large team with many agents.
- **Pending clarifications**: none
- **Delivered results**: none

## Project Status
- **Phase**: starting

## Victory Audit Status
- **Auditor**: N/A (`teamwork_proof` verifies via its own verification phase)
- **Triggered**: no
- **Verdict**: pending
- **Retry count**: 0

## Artifact Index
- `<appData>/scratch/teamwork/<run-id>/.agents/teamwork/ORIGINAL_REQUEST.md` — verbatim original request
- `<appData>/scratch/teamwork/<run-id>/.agents/teamwork/sentinel/BRIEFING.md` — sentinel briefing
