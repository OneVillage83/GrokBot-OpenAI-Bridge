# GrokBot OpenAI Bridge

A working CLI MVP that keeps architecture in an **existing ChatGPT conversation**, implementation in durable Codex workstreams across registered repositories, and the user in control.

| Role | Authority |
| --- | --- |
| ChatGPT | Architect / reviewer, using the selected conversation's history |
| GrokBot | Supervisor / courier, using its persistent browser and this CLI |
| Codex | Programmer |
| Git / tests | Evidence |
| User | Final authority |

```text
          USER
            |
            v
  EXISTING CHATGPT THREAD <------------------+
     architecture / review                  |
            |                               |
            v                               |
     GROKBOT BRIDGE                         |
            |                               |
            v                               |
          CODEX                             |
            |                               |
            v                               |
       REPO + TESTS                         |
            |                               |
            v                               |
     GROKBOT BRIDGE ---- raw evidence -------+
            |
     next instruction or human stop
```

## What works

- TypeScript CLI and SQLite schema 2: one logical project, multiple registered repositories and durable Codex workstreams.
- Explicit ChatGPT routing to one authorized repository/workstream per turn. Unknown, disabled, mismatched or multiple targets fail closed; GrokBot cannot add repositories or broaden scope.
- Review packets include new UTF-8 file contents and completed Codex patches. Binary files use metadata; oversized evidence stops with full private snapshots retained.
- Official Codex App Server over stdio: ChatGPT account authentication, durable threads, turns, events, results, interruptions and recovery.
- Browser-first **courier workflow**: GrokBot operates its own existing browser, posts an exact durable outbox message, and imports the observed response. No ChatGPT model API, API fallback, replacement conversation, or cookie extraction exists.
- Exact conversation URL and pinned visible title checks, response correlation, stale/duplicate protection, repository/branch checks, and one active run per project.
- First run limited to one Codex development turn plus ChatGPT review. Multi-turn operation requires a successful controlled test and explicit human enablement.

**Browser automation status:** native GrokBot browser operation has not been tested here. This CLI does not control a browser by itself. The reusable skill instructs GrokBot to perform each browser handoff; a human can perform the same procedure. Receipts are operator attestations, not independent browser measurements.

**Codex status:** the prior v0.1 integration was verified with a real App Server connection, ChatGPT login, a minimal no-tool turn, streamed completion and same-thread resumption using the pinned official client. This does not establish the full Daily Line workflow or development-tool execution; see [validation](docs/VALIDATION.md). The v0.2 hardening pass ran 50 automated tests and no live model turn.

## Install and start

Requires Node.js 24.11+ and Git on **GrokBot's computer**. The dependency lock pins the official Codex client; no separate global installation is needed.

```sh
git clone --branch bridge/mvp https://github.com/OneVillage83/GrokBot-OpenAI-Bridge.git
cd GrokBot-OpenAI-Bridge
npm ci
npm run build
npm test
npm link
bridge init
bridge auth codex
```

Run these in the checkout. On this machine the checkout is `E:\GrokBot OpenAI Bridge`, on branch `bridge/mvp`. `npm link` creates the local `bridge` command; it does not publish anything. If global linking is unavailable, use `node dist/src/cli/main.js` in place of `bridge`.

Copy `config/daily-line.example.json` to your private `daily-line.json`, replace the exact existing ChatGPT URL, visible conversation title, repository URL and absolute local path, then:

```sh
bridge project add --file daily-line.json
bridge repo prepare daily-line --repository The-Daily-Line-Automation --clone
bridge doctor daily-line
bridge start daily-line --repositories The-Daily-Line-Automation --task "Continue DL-Agent-1."
bridge outbox daily-line --output handoff
```

Do not paste the literal example values into live configuration. `repo prepare` creates or selects the configured working branch and requires a clean repository. It never merges. Without `--clone`, it requires an existing repository.

Next, give GrokBot [the skill](skills/grokbot-openai-bridge/SKILL.md) and follow [the browser workflow](docs/CHATGPT_BROWSER_WORKFLOW.md). A successful `browser receive` leaves the run ready; `bridge continue daily-line` executes one instruction and prepares the review handoff. GrokBot performs these commands as part of its coordinator loop.

## Multi-repository model and upgrades

The Daily Line is one project containing repositories such as Daily-MLB, Daily-NFL, Daily-NCAAF, Daily-Data-Core, Daily-Model-Core and The-Daily-Line-Automation, each with registered workstreams. The example config registers only Automation for the first smoke test. Future Daily-* repositories can be added by the user. This release deliberately executes one repository per turn; it does not split cross-repository instructions.

Existing schema-1 installations must stop all controllers and run `bridge migrate`. This creates a consistent backup, converts the legacy repository/workstream to `primary`, preserves its Codex thread and raw artifacts, and disables autonomy. Active runs require reconciliation and cancellation before a new v2 run; the migrated repository's default branch must be supplied. See [migration steps](docs/OPERATIONS.md#schema-1-to-2-migration). Existing legacy JSON config must use `repositories` and `workstreams` arrays.

CI runs install, typecheck, formatting and all tests on push/PR. It never runs the subscription-consuming live smoke.

## Documentation

- [Quickstart and controlled live test](docs/QUICKSTART.md)
- [Browser workflow and login](docs/CHATGPT_BROWSER_WORKFLOW.md)
- [Codex integration](docs/CODEX_INTEGRATION.md)
- [Architecture](docs/ARCHITECTURE.md) and [response protocol](docs/BRIDGE_PROTOCOL.md)
- [Teach / install the GrokBot skill](docs/GROKBOT_SKILL.md)
- [Operations](docs/OPERATIONS.md), [troubleshooting](docs/TROUBLESHOOTING.md), [security](SECURITY.md)

## MVP boundaries

Approval requests are captured and declined, then the turn is interrupted for human handling. Optional `local-edits` policy accepts only bounded non-deletion file changes; shell/network/permission requests always stop. A grant-and-resume approval UI is not implemented. Use `recover` to collect the interrupted result and have ChatGPT formulate the next step after the human resolves the boundary.

There is no direct ChatGPT DOM adapter, unattended browser daemon, CLI/Exec fallback, dashboard, scheduler, automatic merge/deploy, or model-API mode. App Server is the implemented Codex adapter. Browser login, the exact Daily Line conversation and repository, and the first end-to-end smoke test require the user's environment. These are explicit readiness requirements, not silently substituted services.
