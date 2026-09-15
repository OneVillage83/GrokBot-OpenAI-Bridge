# Validation record

Tested on September 15, 2026 in `E:\GrokBot OpenAI Bridge` on Windows, Node.js 24.11.1. Development branch: `bridge/mvp`.

## v0.2 hardening verification

- TypeScript build and type checks.
- 50 automated tests, retaining the original 32 cases: successful loop; continue/retry/user-decision/completion; Codex failure and failed tests; approval boundaries; wrong thread/repository/branch; duplicate response/instruction/run; loop limits; durable restart/recovery; strict response parsing; receipt type checks; stale capture/deadline checks; local-edit path bounds; structured log redaction; real Git evidence collection; App Server subprocess event ordering.
- Tests use fake ChatGPT/Codex adapters, actual in-memory SQLite, disk SQLite for restart recovery, an isolated real Git repository and a fake stdio server. They do not require ChatGPT browser login or invoke live model turns.
- Added coverage: new UTF-8 source/documentation in the actual review packet; completed Codex patches; binary/invalid UTF-8 metadata and complete snapshots; per-file/aggregate/full-packet overflow; full tracked Git capture; unsafe paths; atomic multi-repository registration; selected routing; unauthorized/disabled/mismatched/multiple targets; per-repository evidence separation; workstream thread persistence across database reopen; selected sandbox roots; explicit schema migration, backup integrity and no old-instruction replay.
- Push/PR CI runs `npm ci`, typecheck, formatting and `npm test` on Ubuntu/Node 24. The [first hardening CI run](https://github.com/OneVillage83/GrokBot-OpenAI-Bridge/actions/runs/35015484383) passed on implementation commit `3fc164f54dc528da8823146e28053fe9c9d4f815`. No live smoke command is in CI.
- GrokBot skill frontmatter/naming validation using the skill-creator validator.

## Prior v0.1 live validation (not repeated during hardening)

- Real official Codex App Server initialize/config/account handshake using normal ChatGPT authentication.
- Real no-tool Codex turn using pinned `@openai/codex` 0.154.0: completed with `BRIDGE_CODEX_SMOKE_OK`, then resumed the same thread. Captured 20 notifications/events. Local private report: `.local/codex-live-smoke/report.json`; transcript events: `.local/codex-live-smoke/events.json`.

The global Codex 0.148.0 installation authenticated but its model request was rejected as too old. A newer client was installed as a pinned **project dependency**; the global installation was not changed. No alternative model or API billing mode was substituted.

## Not verified / incomplete

- GrokBot native browser access, login, real ChatGPT posting/capture and independent thread observation.
- The controlled Daily Line end-to-end test: the exact conversation URL has been supplied privately; authenticated browser access, exact visible title and target repository configuration still require confirmation in the operator environment. No Daily Line live turn was run during this hardening pass.
- Real Codex repository edits, test execution and live approval requests through the bridge. The live smoke deliberately requested no tools; automated tests cover those adapter/orchestration paths.
- macOS runtime validation and live browser/Codex sandbox behavior on other hosts. Automated tests passed locally on Windows and in Ubuntu CI.
- Approval-grant/resume UI; direct DOM/CDP adapter; unattended daemon; CLI fallback; arbitrary repository/workstream identity rebinding; simultaneous cross-repository coding; dashboard; scheduler; large evidence attachments; production isolation.

The built courier workflow is usable once GrokBot has the configured browser/repository and login. It is not yet a verified autonomous browser integration or a production-hardened service.

## Repeat

```sh
npm ci
npm run typecheck
npm run format:check
npm test
npm run build
```

The hardening pass does not invoke App Server or model smoke scripts. `npm run smoke:codex` is an optional connection/authentication probe. `npm run smoke:codex-live` additionally consumes a small amount of the logged-in Codex subscription allowance for its no-tool reply. For the actual first project test, use `docs/QUICKSTART.md` and retain all run artifacts for human review.
