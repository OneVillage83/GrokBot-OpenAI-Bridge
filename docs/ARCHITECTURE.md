# Architecture

The existing ChatGPT conversation owns architecture, review and routing. GrokBot transports exact messages and evidence. Codex implements the selected instruction. The user remains final authority. There is no model API fallback.

## Project, repositories and workstreams

```text
The Daily Line (Project) -> existing ChatGPT architecture conversation
  |-- Daily-MLB                 -> workstream -> durable Codex thread
  |-- Daily-NFL                 -> workstream -> durable Codex thread
  |-- Daily-NCAAF               -> workstream -> durable Codex thread
  |-- Daily-Data-Core           -> workstream -> durable Codex thread
  |-- Daily-Model-Core          -> workstream -> durable Codex thread
  +-- The-Daily-Line-Automation -> automation-agent-1 -> durable Codex thread
```

This illustrates the supported model, not an already registered ecosystem. Future `Daily-*` repositories can be registered by the user. The first controlled smoke configuration contains only `The-Daily-Line-Automation`.

| Record | Owns |
| --- | --- |
| `Project` | Project ID/name, exact ChatGPT URL/title, status, task, approval policy, timeout, turn limits and human autonomy gate |
| `ProjectRepository` | Repository/project IDs, logical name, origin URL, absolute checkout, default/working branches, role and enabled flag |
| `CodexWorkstream` | Workstream/project/repository IDs, persistent Codex thread ID, current task and status |
| `Run` | Fixed authorized repository IDs, separate baseline HEAD per repository, pending route, turn budget and controlled-test status |
| `CodexTurn` | Exact instruction, repository/workstream/thread IDs, remote turn ID and result |

A workstream belongs to one repository. Several workstreams may use that registered checkout sequentially; their Codex threads are distinct. Checkout, origin and working branch cannot be silently rebound to an existing repository identity. A persisted thread cannot be replaced or shared by another workstream. These identities survive process and database restarts.

## Routing and access

`start --repositories ID1,ID2` snapshots the user's allowed repository set; omission uses all enabled registered repositories. ChatGPT sees that catalog and matching workstreams in every outbox. A continuation must choose exactly one registered, enabled repository in the run scope and its matching workstream. Unknown, disabled, foreign, mismatched or multiple targets fail closed. GrokBot cannot add repositories from a model decision or split cross-repository instructions itself.

This release supports multi-repository projects with **one repository per Codex turn**. Later separately routed turns can select other authorized repositories only within the human-enabled budget. There is no simultaneous cross-repository turn or automatic scope expansion.

The selected checkout is verified against its origin, canonical root, working branch and Git state. Registered checkout roots must not overlap one another or private state. Routing rechecks canonical overlap. Codex receives the selected cwd, explicit repository/workstream policy and a workspace-write sandbox with exactly that root, network disabled and temporary-directory write exemptions disabled. External MCP/app tools and web search are disabled; permission expansion is refused. Host sandbox enforcement remains a trust boundary; see [Security](../SECURITY.md).

## Implementation and durability

```text
CLI -> Orchestrator -> browser outbox/receipt -> GrokBot browser
                   -> route validation -> Codex App Server -> selected repository
                   -> GitAdapter -> per-repository evidence and private snapshots
                   -> SQLiteStore -> registry/runs/turns/events/approvals/artifacts
```

The state graph remains:

```text
IDLE -> PREPARING -> SEND_TO_CHATGPT -> WAITING_FOR_CHATGPT
 -> PARSING_CHATGPT_DECISION -> READY_FOR_NEXT_CODEX_TURN
 -> SEND_TO_CODEX -> WAITING_FOR_CODEX -> COLLECTING_EVIDENCE
 -> SEND_TO_CHATGPT -> review decision

Decisions/errors -> WAITING_FOR_USER / PAUSED / COMPLETED / FAILED
Budget exhaustion -> PAUSED with the next instruction retained
```

SQLite schema 2 adds `project_repositories` and `codex_workstreams` alongside projects, runs, ChatGPT/Codex turns, approvals, artifacts, events and locks. Schema 1 requires explicit backed-up migration; see [Operations](OPERATIONS.md). Registry bundles and decisions are transactional. WAL, a busy timeout, one-active-run index and PID/hostname locks retain concurrency protections. One controller runs per project, including across its repositories.

Intent is persisted before external dispatch. No local transaction can atomically commit a browser/model side effect. Unknown delivery stops for reconciliation; known Codex recovery reads the original turn. Browser claims persist across restart and cannot be resent. This protects against replay without claiming exactly-once remote delivery.

## Evidence

Every authorized checkout starts clean with its own baseline HEAD. After a turn, Git evidence is stored under `repositories[repository_id]`, with the workstream and turn linked separately. Only the selected repository's evidence is returned for that turn. Evidence from other repositories is not merged into its diff. Tracked changes since baseline include committed and current worktree changes, plus staged stats, status and commits.

Untracked regular files are streamed to complete private snapshots with path, byte count and SHA-256. Valid UTF-8 text reaches the actual review packet. Invalid UTF-8 or binary control characters produce metadata only, with an explicit omission reason and complete local bytes. Symlinks, escaping paths, unstable or unreadable files stop review. Ignored files are excluded by Git; binary internals are not reviewed by ChatGPT. Completed Codex `fileChange` items and their observed patches also enter the review packet. Full raw events and results remain local.

| Limit | Behavior when exceeded |
| --- | --- |
| 32 KiB per untracked text file | Preserve full file snapshot; halt before review |
| 64 KiB aggregate untracked text | Snapshot all listed files; halt before review |
| 128 KiB per Git command's stdout | Stream complete stdout to disk; omit inline text and halt |
| 100,000 UTF-8 bytes for the complete browser message, including catalog/footer | Preserve raw body/candidate; enqueue no partial review |

Nothing is silently truncated or automatically split. Snapshots have no archival size cap: enough private disk space is required. If capture fails (including disk exhaustion), retain available partial artifacts and stop; do not claim a complete snapshot. If the untracked manifest itself exceeds its limit, its full raw list is retained and per-file ingestion stops for human review. Original files remain in the checkout.

Recorded command events establish exit codes and observed checks. Codex prose alone never proves success. Missing checks remain NOT RUN / NOT OBSERVED. Raw snapshots, database artifacts, backups and exports can contain secrets and must remain private.
