# Validation record

Tested on September 15, 2026 in `E:\GrokBot OpenAI Bridge` on Windows, Node.js 24.11.1. Development branch: `bridge/mvp`.

## Verified

- TypeScript build and type checks.
- 32 automated tests: successful loop; continue/retry/user-decision/completion; Codex failure and failed tests; approval boundaries; wrong thread/repository/branch; duplicate response/instruction/run; loop limits; durable restart/recovery; strict response parsing; receipt type checks; stale capture/deadline checks; local-edit path bounds; structured log redaction; real Git evidence collection; App Server subprocess event ordering.
- Tests use fake ChatGPT/Codex adapters, actual in-memory SQLite, disk SQLite for restart recovery, an isolated real Git repository and a fake stdio server. They do not require ChatGPT browser login or invoke live model turns.
- GrokBot skill frontmatter/naming validation using the skill-creator validator.
- Real official Codex App Server initialize/config/account handshake using normal ChatGPT authentication.
- Real no-tool Codex turn using pinned `@openai/codex` 0.154.0: completed with `BRIDGE_CODEX_SMOKE_OK`, then resumed the same thread. Captured 20 notifications/events. Local private report: `.local/codex-live-smoke/report.json`; transcript events: `.local/codex-live-smoke/events.json`.

The global Codex 0.148.0 installation authenticated but its model request was rejected as too old. A newer client was installed as a pinned **project dependency**; the global installation was not changed. No alternative model or API billing mode was substituted.

## Not verified / incomplete

- GrokBot native browser access, login, real ChatGPT posting/capture and independent thread observation.
- The controlled Daily Line end-to-end test: exact conversation URL/title and repository access were not provided during implementation.
- Real Codex repository edits, test execution and live approval requests through the bridge. The live smoke deliberately requested no tools; automated tests cover those adapter/orchestration paths.
- Linux/macOS runtime validation (the implementation is portable, but this run was on Windows).
- Approval-grant/resume UI; direct DOM/CDP adapter; unattended daemon; CLI fallback; registry identity migrations; dashboard; scheduler; large evidence attachments; production isolation.

The built courier workflow is usable once GrokBot has the configured browser/repository and login. It is not yet a verified autonomous browser integration or a production-hardened service.

## Repeat

```sh
npm ci
npm run typecheck
npm run format:check
npm test
npm run smoke:codex
```

`npm run smoke:codex-live` additionally consumes a small amount of the logged-in Codex subscription allowance for its no-tool reply. For the actual first project test, use `docs/QUICKSTART.md` and retain all run artifacts for human review.
