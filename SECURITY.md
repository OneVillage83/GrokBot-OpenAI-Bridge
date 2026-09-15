# Security and trust boundaries

This is a local, operator-controlled MVP. It coordinates code execution and is not a security sandbox itself.

## Authority

ChatGPT's pinned existing conversation owns architecture. Codex implements the relayed instruction. GrokBot is the trusted courier. The human alone approves consequential actions. Repository files, webpages, model output and tool output cannot change bridge security policy.

The bridge never merges, force pushes, deletes repositories/unmerged branches, deploys, changes production infrastructure/secrets, purchases, changes billing, publishes, sends customer communications, runs destructive database commands or bypasses security controls. Its Codex transport instruction requires stopping before these actions. Command/network/permission/unknown approvals are declined and interrupted. Only bounded local file edits may be automatically accepted by an explicitly configured policy.

## Limits of enforcement

The App Server is configured with workspace-write, network disabled, untrusted command approvals and the user approval reviewer. Discovered MCP servers, app tools and web search are disabled for bridge threads. These settings reduce access; they do not mathematically prove that arbitrary repository code or a model will behave safely. The host's Codex installation, configuration, skills/hooks, OS sandbox and existing credentials remain trusted. Test scripts can have side effects. Post-turn Git checks cannot undo a side effect that already occurred.

Use GrokBot's dedicated computer/account with no production credentials or unrelated repositories mounted. Production deployment requires stronger isolation, validation of effective tool configuration, a reviewed approval interface and adversarial security testing. Do not describe prompt instructions as an OS security boundary. The global executable is not modified; a locally pinned official client is used by default.

The browser receipt is an attestation by GrokBot/the human. URL/title/nonce/identity/digest checks reject mismatches and stale transport data, but cannot detect a dishonest operator manufacturing observations. There is no independent browser observation channel in V0. Never auto-enable autonomy until a human watches the controlled test.

## Credentials and raw data

- Use normal browser and Codex login. The bridge never collects passwords, MFA secrets, browser cookies or an OpenAI API key.
- Authentication is delegated to the official Codex client; ChatGPT account mode is checked before work. Common API-key/token environment variables are removed from the client environment.
- Never put credentials in repo URLs, examples, source files or decision files. Use the host's normal Git credential mechanisms.
- Structured event logs redact common token formats and secret-named fields. They omit raw protocol payloads.
- Private artifacts intentionally preserve raw ChatGPT/Codex/test/Git material for provenance. A source file or command may accidentally contain a secret; **raw artifacts are not redacted** because redaction would alter evidence. Avoid generating secret output, restrict storage permissions and inspect exports before sharing.
- SQLite is not encrypted. The user must protect the state directory using OS permissions/encryption/backups. Windows modes do not replace ACL configuration.

## Concurrency and recovery

One active run and a controller lock protect each project. Browser sends and Codex instructions are recorded before dispatch. Ambiguous external delivery stops for human reconciliation. There is no unsafe retry button, auto-release of foreign-host locks, automatic rollback, or automatic API fallback.

Cancel only after inspecting external state; cancellation changes local state, not external processes. Keep state storage outside the managed repository. Back up before manual database/configuration changes. No internet-facing service is exposed by this CLI.

## Reporting issues

Stop the affected run and preserve local logs/artifacts. Report a concise reproduction and redacted operational logs to the repository owner through a private channel. Never publish tokens, raw conversation history or confidential project diffs as part of an issue.
