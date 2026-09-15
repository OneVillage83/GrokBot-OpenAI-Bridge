# Operations

## Commands and exits

Run `bridge --help` for the complete command list. Each command outputs JSON except help, fingerprints and the official login flow. Exit 0 means the command succeeded; exit 1 means an invalid command/configuration or unrecoverable CLI error; exit 2 means a persisted human stop/failure or incomplete doctor readiness.

```sh
bridge status daily-line
bridge history daily-line
bridge logs --run RUN_ID
bridge artifacts --run RUN_ID --output PRIVATE_DIRECTORY
bridge pause daily-line
bridge recover daily-line
```

`continue` executes only when ready. `resume` releases a reviewed pause or sends a user decision to ChatGPT; it does not itself execute code. `recover` reconciles persisted external work; it does not start another Codex turn. A completed/failed run cannot be resumed as though still active. Start a new run with the same durable project Codex thread.

## Pause and approvals

Another terminal can issue `pause` while Codex is running. The controller polls every 500 ms, requests interruption and stops. An already completed external side effect cannot be undone by pause. Use `recover` before new work to collect partial/completed results.

Approval requests are stored in SQLite `approvals` and visible in the exported raw event/turn evidence. `human` (default) declines and interrupts. `local-edits` may accept only an explicitly observed non-deletion file-change item inside the working repository without an expanded grant root. Commands, network permissions, unknown requests and security changes always stop. V0 has no approval-grant command; human resolution happens outside the bridge, then recovery and a user decision are routed to ChatGPT. Inspect `approvals` with a trusted SQLite viewer if needed.

Never use a model-authored decision file as human approval. Only the user may authorize enabling autonomy, increasing budgets or resolving protected boundaries.

## Recovery rules

| Persisted condition | Action |
| --- | --- |
| Pending browser packet | Inspect and claim it once |
| Claimed/sent browser packet | Find the existing request in the pinned thread; do not resend |
| Received response, decision not yet parsed | `recover` parses the saved response |
| Known Codex turn, completed | `recover` reads the original turn and collects evidence |
| Known Codex turn still active | Stop; inspect the active Codex process/thread |
| Codex intent without remote turn ID | Stop; manually reconcile history, never replay |
| Parsed instruction at budget limit | Human review, then `resume --additional-turns N` |
| Invalid parsed response | Human correction via `resume --decision-file FILE` |
| No reliable recoverable checkpoint | Inspect artifacts; cancel only after reconciling external state |

`bridge cancel daily-line --reason "Human reviewed and reconciled external state"` closes the registry run as failed. It does not terminate an arbitrary orphan server, revert a repository or delete anything. Do not cancel an active controller; pause it first and wait for it to exit.

## Data, locks and backups

One active run per project is enforced by SQLite. Mutating controller commands hold a PID/hostname lock. A same-host dead process lock is reclaimed; live/permission-uncertain/foreign-host locks are not. Shared/network-drive multi-host control is unsupported. Never copy an active database to another host and assume its process locks remain meaningful.

For a portable backup, stop all bridge commands and copy the private state directory including database, WAL and SHM if present, or use SQLite's online backup tooling. Preserve Codex's normal account/thread storage separately through its supported mechanisms. The bridge database does not contain OAuth credentials, but raw artifacts may contain sensitive project material.

State lives outside managed repositories. Restrict filesystem access to the operator account. Unix directory/file modes are best-effort; configure Windows ACLs appropriately. No built-in encryption, retention pruning or migrations are provided. `PRAGMA user_version` records version 1; newer schemas are refused.

## Configuration

See `.env.example` for optional environment variable names. It is explanatory; the bridge does **not** automatically load `.env`. Project settings are validated on registration. `timeout_ms` bounds Codex turns, browser claim-to-receipt duration and receipt freshness. App Server requests have a 30-second deadline. `status` exposes `browser_timeout_detected`; expired browser receipts are refused. Immediate timeout notification during a browser wait requires GrokBot's own timer because no bridge daemon runs between courier commands.

If ChatGPT does not finish within the project timeout, GrokBot must pause and report the observed reason. Capturing a fresh timestamp does not justify treating interrupted or stale content as a completed response.
