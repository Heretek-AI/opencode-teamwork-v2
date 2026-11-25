# AGENTS.md

Instructions for coding agents working in this repository.

## What this is

`@heretek-ai/opencode-teamwork-v2` is a zero-runtime-dependency OpenCode V2
plugin: 26 `teamwork_*` engine tools, 7 slash commands, and 15 agent markdown
files. The shipped package must keep working with `dependencies: {}`.

- Plugin entry: `plugins/opencode-teamwork/index.ts` (`{ id, setup }`).
- Engine: `plugins/opencode-teamwork/tools.ts` plus the modules beside it.
- Agents: `agents/team/*.md` (installed by `init`/postinstall, verified by `setup`).
- CLI: `bin/opencode-teamwork.mjs`, `lib/*.mjs`.
- Unit suite: `scripts/test-*.mjs`, run by `npm test`.

## Hard contract rules

These are not style preferences; breaking them breaks the product.

1. **OpenCode 2.4.1 is the supported host.** The audited contract and the drift
   list are in [`docs/OPENCODE-COMPATIBILITY.md`](docs/OPENCODE-COMPATIBILITY.md)
   and [`docs/adr/0017-opencode-plugin-contract-and-test-strategy.md`](docs/adr/0017-opencode-plugin-contract-and-test-strategy.md).
   `package.json` carries an optional peer `@opencode/plugin: ^2.4`; `setup`
   warns on a non-2.4 `ctx.app.version`.
2. **Tools register under effective names.** Every `editor.add` must pass
   `options: { namespace: "teamwork", codemode: false }`. The model-facing id is
   `teamwork_<name>`; `editor.namespace()` alone is catalog metadata and does not
   prefix anything. Prompts and commands must reference the same names.
   `scripts/test-catalog.mjs` fails on a bare registration or an unresolved token.
3. **No `output` key without an output schema.** OpenCode only surfaces
   `content` (plus declared output); an undeclared `output` is a runtime defect.
4. **Input validation is ours.** The host silently strips unknown properties, so
   every tool input goes through `strictInput()` (`tool-schema.mjs`). Do not
   replace it with a plain JSON schema.
5. **Storage is global per plugin id.** `ctx.storage` is a SQLite KV with JSON
   values, no CAS and no TTL. Do not assume per-project or transactional writes.
6. **Identity.** Use the tool call's `context.agent` first, then
   `Session.Info.agent`. Forks are a separate ancestry edge; never assume
   `parentID` is present.
7. **Paths.** Resolve `OPENCODE_DB` and the channel-specific DB/service names.
   Never hardcode `opencode.db` or `service.json`.

## Testing

```sh
npm test                                  # L0: unit, catalog, verifier, security
npm run lint:prompts                      # after changing agents or commands
node scripts/lint-security-claims.mjs     # after changing docs
npm pack --dry-run                       # packaging guard; tests/ and docs/re/ must not ship

cd tests/runtime
bun install --frozen-lockfile
bun run test                              # L1-L3 against the real OpenCode 2.4.1
```

- `tests/runtime/` is dev-only: bun, exact `@opencode/*@2.4.1`, excluded from
  `files`, root dependencies stay empty.
- L1 loads the plugin from memory and from a local directory, asserts the 26-tool
  catalog, commands, permissions, storage namespacing, agent decoding and result
  shape. L2 drives tool scenarios (plan, claims, evidence, approvals). L3 runs
  full workflows in real worktrees, including a two-process claim race and the
  verifier CLI.
- Assertions go on tool results and artifacts (`state.json`,
  `run.manifest.json`, `verify/*`, `handoffs/index.json`, `events.jsonl`, exit
  codes), never on model prose.
- No model calls in the default suite. Live-model work is opt-in (issue #38).
- If a test reveals a product defect, record it in `tests/runtime/FINDINGS.md`
  and skip the spec with a reason; fix the product on a separate branch.

## Change checklist

1. Branch from `main`; do not merge or open a PR unless asked.
2. Add or update tests first where practical; the catalog golden and L1 are the
   guardrails for the tool contract.
3. Update `CHANGELOG.md` and bump `package.json` (lockstep with
   `plugins/opencode-teamwork/package.json` when it changes).
4. Run `npm test`, the runtime suite, the claim lint and the packaging guard.
5. Keep the package dependency-free; no `@opencode/*` import in shipped code.

## Security claims

- Run `node scripts/lint-security-claims.mjs` before touching docs. It blocks
  "tamper-proof", "trusted signature", "safe against a local user" and similar
  marketing claims.
- Never claim that signing proves a human read an artifact, that CI proves code
  correctness, that a witness proves an observation, or that containment
  prevents a same-UID writer.
- The honest boundaries are documented in `SECURITY.md`, `docs/GUARDRAILS.md`
  and ADRs 0005/0006/0008/0013/0018.

## Where things live

| Path | Purpose |
|---|---|
| `plugins/opencode-teamwork/` | plugin, tools, auth, containment, approvals |
| `agents/team/` | 15 agent prompts (markdown) |
| `lib/`, `bin/` | CLI: run reports, verify, approve, doctor |
| `docs/ARTIFACTS.md` | run/artifact schema |
| `docs/GUARDRAILS.md` | security boundary |
| `signer/` | Rust reference non-oracle signer (never shipped in the npm package) |
| `docs/ADMIN-HARDENING.md` | hardened deployment runbook |
| `docs/SIGNER-PROTOCOL.md` | non-oracle signer contract |
| `docs/OPENCODE-COMPATIBILITY.md` | host API audit and test strategy |
| `sonar-project.properties` | SonarCloud project/scope config (not shipped; policy in the audit report §3.2.1) |
| `docs/re/` | reverse-engineering corpus (never shipped) |
| `tests/runtime/` | L1-L3 integration harness (never shipped) |

## Open work

Open GitHub issues: #38 (L4 live-model suite), #40 (admin hardening applied on a
real host), #48 (remaining Document Review/PDF corpus), #51 (document-review
visual audit) and #52 (per-dispatch model override). The 0.19.2
security/release work — verify re-run trust gate, `--allow-unsigned`
restriction, attestation input validation, fail-closed trust/evidence, and the
Sonar/packaging checks — is tracked in the changelog and pull requests. The
host-drift, NFS, containment-incident, signer, OIDC, strict-input,
packed-tarball and process-E2E items (#39, #41–#47) are implemented and closed.
