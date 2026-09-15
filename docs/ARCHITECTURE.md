# Architecture

The bridge coordinates transport and evidence. It performs no architectural reasoning and never substitutes another model for the existing ChatGPT thread.

```text
CLI -> Orchestrator -> ChatGPTAdapter -> durable browser courier -> GrokBot browser
                   -> CodexAdapter  -> official App Server child -> repository work
                   -> GitAdapter    -> root / origin / branch / diff evidence
                   -> SQLiteStore   -> runs / turns / events / artifacts / approvals
```

## Implementation layout

| Directory | Responsibility |
| --- | --- |
| `src/core` | State graph, protocol, transport safety policy, orchestration and types |
| `src/adapters/chatgpt` | Browser outbox claims and observation receipts |
| `src/adapters/codex` | App Server RPC/event lifecycle and executable resolution |
| `src/adapters/git` | Repository preparation, identity checks, evidence |
| `src/adapters/storage` | SQLite transactions, persistence, locks, audit artifacts |
| `src/cli`, `src/config`, `src/logging` | Commands, validated registry input, redacted logs |
| `skills` | Portable GrokBot coordinator instructions |
| `tests` | Fake adapters, in-memory SQLite, disk recovery and subprocess protocol tests |

## State graph

```text
IDLE -> PREPARING -> SEND_TO_CHATGPT -> WAITING_FOR_CHATGPT
                                      |
                                      v
                            PARSING_CHATGPT_DECISION
                              |           |          |
                  READY_FOR_NEXT_CODEX_TURN |     COMPLETED / FAILED
                              |       WAITING_FOR_USER
                       SEND_TO_CODEX
                              |
                      WAITING_FOR_CODEX
                              |
                     COLLECTING_EVIDENCE
                              |
                       SEND_TO_CHATGPT -> repeat review

Any active state -> WAITING_FOR_USER / PAUSED / FAILED
Budget exhaustion -> PAUSED, retaining the next instruction
```

Transitions, project status and audit event commit together. Outbox creation and parsed decisions use transactions. SQLite uses WAL, a busy timeout and an active-run unique index. An OS-process lock serializes mutating project commands. Pause is intentionally available from another process and active Codex work polls it every 500 ms.

No transaction can atomically commit a local database and an external browser/model operation. The bridge therefore persists intent before dispatch and refuses automatic replay after uncertain delivery. Recovery reads the original known Codex turn. Claimed browser messages must be reconciled in the original conversation. Correlation is designed for at-most-one automatic dispatch, not an unjustified exactly-once claim.

## Storage

`projects`, `runs`, `chatgpt_turns`, `codex_turns`, `approvals`, `artifacts`, `events` and `locks` are implemented. Small structured records use JSON columns; query-critical identities/states use indexed columns. An extra `bridge_turns` join table was not necessary for V0: each handoff and Codex turn already references the run, and artifacts/events reference the applicable turn.

Raw material is deliberately distinct from redacted operational logs. State schema is version 1. There is no supported cross-version migration or registry identity editor yet; backups and manual review are required before a future schema change.

## Evidence model

A clean tree is required before a new run. Its HEAD is pinned as the baseline. Evidence compares the current tracked worktree to that baseline, including changes committed during the run, and also lists staged stats, status, commits and untracked filenames. Untracked contents are not automatically dumped. Codex file-change events preserve their observed patch data; ignored files and complete newly generated binary contents are not guaranteed to be captured.

Commands retain their observed output and exit status. The bridge does not infer test success from Codex prose or execute test commands extracted from model output. Missing checks remain NOT RUN / NOT OBSERVED. Evidence exceeding the browser transport's 100,000-character limit stops with the full local artifacts retained instead of silently truncating.

## Extension points

A direct browser SDK/CDP implementation may later implement `ChatGPTAdapter` if GrokBot exposes and authorizes such an interface. The default remains the native-browser courier. App Server is the only implemented `CodexAdapter`. A CLI adapter or disabled future API adapter can be added without changing the authority model. No API fallback exists in this build.

Future work: human approval response interface, browser-side independent verification, stronger host isolation, schema migrations, snapshotting large/untracked artifacts, multi-project workers and a dashboard. None are prerequisites for the controlled courier workflow.
