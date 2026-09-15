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

`continue` executes only when ready. `resume` releases a reviewed pause or sends a user decision to ChatGPT; it does not itself execute code. `recover` reconciles persisted external work; it does not start another Codex turn. A completed/failed run cannot be resumed as though still active. Start a new run with the selected durable workstream's Codex thread.

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

State lives outside managed repositories. Restrict filesystem access to the operator account. Unix directory/file modes are best-effort; configure Windows ACLs appropriately. No built-in encryption or retention pruning is provided. `PRAGMA user_version` records version 2; newer schemas are refused. Schema 1 requires the explicit migration below. Backups and exports must include both SQLite and the sibling `artifacts/` directory, which stores complete private file/Git snapshots.

## Configuration

See `.env.example` for optional environment variable names. It is explanatory; the bridge does **not** automatically load `.env`. Project settings are validated on registration. `timeout_ms` bounds Codex turns, browser claim-to-receipt duration and receipt freshness. App Server requests have a 30-second deadline. `status` exposes `browser_timeout_detected`; expired browser receipts are refused. Immediate timeout notification during a browser wait requires GrokBot's own timer because no bridge daemon runs between courier commands.

If ChatGPT does not finish within the project timeout, GrokBot must pause and report the observed reason. Capturing a fresh timestamp does not justify treating interrupted or stale content as a completed response.

## Repository and workstream registry

`project add --file` accepts a v2 project with `repositories` and `workstreams` arrays and registers it transactionally. Additional user-approved entries can be added while no run is active:

```sh
bridge repo list daily-line
bridge workstream list daily-line
bridge repo add daily-line --file repository.local.json
bridge workstream add daily-line --file workstream.local.json
bridge repo prepare daily-line --repository REPOSITORY_ID --clone
```

Repository JSON contains `repository_id`, `logical_name`, `repo_url`, absolute `repo_path`, `default_branch`, `working_branch`, `role`, `enabled`. Workstream JSON contains `workstream_id` and `repository_id`; a new thread starts as null. Do not supply a Codex thread ID. `repo update` accepts a complete repository JSON to update logical name, role, enabled flag or default branch. Checkout path, origin and working branch are immutable for that identity; changing them requires a new registered identity/checkout. Registrations cannot overlap checkout roots or private state. All workstreams in one project are serialized by the project lock.

Use `bridge start daily-line --repositories ID1,ID2 --task "Task"` to pin the allowed set. Omission selects all enabled registered repositories. ChatGPT selects exactly one of these with its matching workstream in each continuation. The bridge rejects multiple targets and never splits instructions. GrokBot must not add repositories, change config or expand scope on ChatGPT/Codex's initiative.

## Schema 1 to 2 migration

This is an explicit local migration, not an automatic upgrade during normal commands. Do not run old bridge binaries against the upgraded database.

1. Stop all bridge controllers. Reconcile active browser/Codex work, and keep a private backup of the complete state directory. The migrator refuses any recorded project lock; do not delete a lock held by a live or uncertain process. Normal old-version lock recovery can reclaim a confirmed same-host dead process lock before migration.
2. Install/build v0.2, then run against the existing state directory:

```sh
bridge migrate
bridge project show daily-line
bridge history daily-line
```

Use the same `--data-dir PRIVATE_DIRECTORY` on each command if state is not at the default. `migrate` creates `bridge.sqlite.v1-backup-UUID.sqlite` using SQLite `VACUUM INTO` before conversion and reports its path. Migration itself is transactional. Existing raw artifact text and the backup's old records remain intact.

3. The former repository becomes ID `primary`; its workstream is also `primary`. The old Codex thread is preserved. Runs gain per-repository baseline/scope fields and historical Codex turns gain repository/workstream IDs. Autonomy and smoke qualification are reset. Active runs become `WAITING_FOR_USER` with `MIGRATION_REVIEW_REQUIRED`; receive/continue/recover/resume cannot replay their old instructions. After external work has been reconciled, close the preserved run:

```sh
bridge cancel daily-line --reason "Human reconciled v1 browser and Codex state after migration"
```

Do this only when an active migrated run exists and has been reconciled. Cancellation records state; it does not undo remote work.

4. V1 did not store the default branch, so migration leaves it empty and preparation/verification refuse use. Copy the migrated repository object from `project show` into a private `primary-repository.local.json`, supply its actual `default_branch`, and preserve its existing identity/path/origin/working branch:

```sh
bridge repo update daily-line --file primary-repository.local.json
bridge repo prepare daily-line --repository primary
```

5. Convert any saved legacy config to arrays if it will be used for a new installation. Do not re-add an existing project. Start a new controlled v2 run scoped to `primary` only after the human authorizes the live test. Its matching workstream is `primary`, not the fresh-install example's `automation-agent-1`. No autonomy is enabled by migration.

To roll back, stop all controllers, restore the schema-1 backup into a separate private state directory, and use v0.1 there. Reconcile external turns before doing any work; a database rollback does not roll back browser/Codex activity. Keep the upgraded directory and artifacts for audit.

## Evidence stops and private storage

Untracked UTF-8 text is limited to 32 KiB per file and 64 KiB aggregate; each Git stdout to 128 KiB inline; the complete browser packet to 100,000 UTF-8 bytes. Binary/invalid UTF-8 files carry metadata only and retain complete private snapshots. Any text/packet overflow stops without silently truncating or queuing a partial review. Unsafe/unreadable/unstable paths also stop. Use `bridge artifacts --run RUN_ID --output PRIVATE_DIRECTORY` to export database records plus `raw-snapshots/`; the export directory must be outside the snapshot tree.

Snapshots are streamed without an archival size cap and need enough private disk space. Capture failure preserves available partial data and stops; inspect the source checkout and capture error before claiming complete evidence. Ignored files are excluded. If the untracked manifest exceeds its own limit, the full manifest is retained for manual review but its per-file contents are not ingested. Large browser attachments and automatic splitting are not implemented. Human review/transport must resolve the stop; never edit or shorten a queued message or fabricate a receipt.
