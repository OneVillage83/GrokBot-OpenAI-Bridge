# Bridge protocol

Every outbound ChatGPT message contains project/run/request IDs, the exact selected project identity, role boundaries and an ordered response contract. Each review includes the raw Codex final message, observed command items, Git evidence and recorded error.

The response may have prose before this footer. It must end with one occurrence of each field, in this order, without a Markdown code fence:

```text
BRIDGE_REQUEST_ID: unique-request-uuid
BRIDGE_STATUS: CONTINUE_CODEX
BRIDGE_CODEX_INSTRUCTION: The complete exact instruction.
It may span multiple lines, including code and indentation.
BRIDGE_USER_ACTION: NONE
BRIDGE_NOTES: Optional notes or NONE
```

| Status | Behavior |
| --- | --- |
| `CONTINUE_CODEX` | Persist exact instruction, become ready unless turn budget exhausted |
| `RETRY_CODEX` | Same relay rules; duplicate instructions still require human reconciliation |
| `USER_DECISION_REQUIRED` | Stop with the exact question |
| `TASK_COMPLETE` | Record completion and stop |
| `PROJECT_PHASE_COMPLETE` | Record phase completion and stop |
| `STOP_ERROR` | Record failure and stop |

Continuation requires a nonempty instruction and user action `NONE`. Stop statuses require instruction `NONE`. User-decision status requires a real human-action message. Unknown status, duplicate/missing/out-of-order fields, inconsistent action, stale request ID or unparseable text causes `WAITING_FOR_USER`.

The parser normalizes CRLF to LF in the relayed field and removes delimiter newlines; it preserves internal line breaks and indentation. Original message/response bytes as captured remain in private raw artifacts. Literal `BRIDGE_*:` field lines inside an instruction conflict with the delimiter grammar and must be returned in another representation by ChatGPT. There is no heuristic prose interpretation or secondary model parser.

## Idempotency and provenance

- Every run, ChatGPT handoff and local Codex turn has a UUID.
- Outbound messages and instructions have SHA-256 digests.
- A browser claim is durable before sending. It cannot be claimed twice.
- A receipt must match the pinned URL/title, full outbound message, claimed handoff and newest observed response identity. Old response IDs cannot be reused within a project. The captured time must be valid and fresh.
- `clientUserMessageId` correlates Codex input; it is **not assumed to provide server-side exactly-once delivery**. Intent is committed before dispatch. Unknown delivery status is never retried blindly.
- A run's repeated instruction digest stops the loop even when ChatGPT uses a fresh response ID.
- Rejected raw receipts, raw ChatGPT responses, Codex instructions/events/results, Git evidence and command output are retained.

Repository content, tool messages and ChatGPT prose cannot change the bridge policy. Only a valid response contract determines the next orchestration action; even that contract cannot approve a protected operation or enable autonomy.
