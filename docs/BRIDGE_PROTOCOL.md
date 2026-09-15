# Bridge protocol v2

Every outbox identifies its project/run/request, authority boundaries and the run's registered authorized repository/workstream catalog. ChatGPT chooses routing. GrokBot transports it unchanged. Repository display names and prose are never interpreted as authorization.

A response may contain prose before exactly one ordered seven-field footer. Do not wrap the footer in a Markdown fence:

```text
BRIDGE_REQUEST_ID: matching-request-uuid
BRIDGE_STATUS: CONTINUE_CODEX
BRIDGE_TARGET_REPOS: ["The-Daily-Line-Automation"]
BRIDGE_WORKSTREAM: automation-agent-1
BRIDGE_CODEX_INSTRUCTION: The complete exact instruction.
It may span multiple lines, including code and indentation.
BRIDGE_USER_ACTION: NONE
BRIDGE_NOTES: Optional notes or NONE
```

`BRIDGE_TARGET_REPOS` is a JSON array of exact registered repository IDs, not a bullet list, path, URL or guessed logical name. Continuations require exactly one target and its matching registered workstream. This release rejects multi-repository turns rather than broadening or splitting them. For cross-repository work, ChatGPT should ask the user to choose an appropriate bounded next step.

| Status | Behavior |
| --- | --- |
| `CONTINUE_CODEX` | Validate route and persist exact instruction; become ready within budget |
| `RETRY_CODEX` | Same route/relay rules; duplicate instruction digests still stop |
| `USER_DECISION_REQUIRED` | Stop with the exact human question |
| `TASK_COMPLETE` | Record completion and stop |
| `PROJECT_PHASE_COMPLETE` | Record phase completion and stop |
| `STOP_ERROR` | Record failure and stop |

Continuations require a nonempty instruction and user action `NONE`. All stop statuses require targets `[]`, workstream `NONE` and instruction `NONE`. User-decision status requires a real question/action. For example:

```text
BRIDGE_REQUEST_ID: matching-request-uuid
BRIDGE_STATUS: TASK_COMPLETE
BRIDGE_TARGET_REPOS: []
BRIDGE_WORKSTREAM: NONE
BRIDGE_CODEX_INSTRUCTION: NONE
BRIDGE_USER_ACTION: NONE
BRIDGE_NOTES: Reviewed the evidence and completed this task.
```

Wrong, disabled or unauthorized repositories, unknown/mismatched workstreams, duplicate IDs, multiple targets, missing/out-of-order fields, stale request IDs and inconsistent fields stop in `WAITING_FOR_USER` before Codex dispatch. The bridge never registers a model-requested repository. Protocol v1 five-field responses are rejected; migrated active runs require human reconciliation, cancellation and a fresh v2 request.

The parser normalizes CRLF to LF and removes delimiter newlines while preserving internal instruction line breaks and indentation. Literal `BRIDGE_*:` field lines inside an instruction conflict with the grammar and must be represented differently by ChatGPT. There is no heuristic prose parser or secondary model. Captured originals remain in private raw artifacts.

## Evidence and provenance

Review messages carry the raw Codex final response, recorded commands/errors, completed file-change patches, and Git evidence keyed by repository ID. New UTF-8 content is included within [explicit limits](ARCHITECTURE.md#evidence); binary entries carry metadata. Oversized/unsafe evidence stops the handoff with local artifacts retained. The complete message limit includes the catalog and footer and is measured in UTF-8 bytes.

Run/handoff/Codex-turn UUIDs and SHA-256 digests preserve correlation. Claims persist before browser sends. Receipts must match the exact URL/title, observed outbound message, request and fresh response identity; prior response IDs cannot be reused within a project. Codex client message IDs are correlation identifiers, not an assumed remote exactly-once guarantee. Unknown dispatch status is never retried blindly. Repeated instruction digests stop even with a fresh ChatGPT response ID.

Raw responses, rejected receipts, decisions, instructions, events, results and evidence remain available. A valid footer cannot approve protected operations, add repositories, expand the run scope, enable autonomy or increase its budget. The first controlled run stops after one Codex turn and ChatGPT review.
