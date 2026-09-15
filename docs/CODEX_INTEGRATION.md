# Codex integration

## Official interface and installed version

The adapter uses [OpenAI's App Server](https://learn.chatgpt.com/docs/app-server): a child process with newline-delimited bidirectional JSON messages over stdio. It initializes, starts/resumes durable threads, starts turns and captures streamed notifications. Codex manages ChatGPT login. This is a local authenticated Codex integration, not a replacement model-API conversation.

The project pins `@openai/codex` **0.154.0** and prefers its local executable. Wire values were checked against `codex app-server generate-ts` from the installed client. In particular, this version requires approval policy `untrusted`; a web documentation example used `unlessTrusted`, which the client rejected. The adapter uses the locally validated spelling and provides `text_elements: []` in text input. Protocol validation should accompany future upgrades.

## Implemented methods

| Method / event | Handling |
| --- | --- |
| `initialize`, `initialized` | One handshake per connection |
| `config/read` | Discover configured MCP servers, disable them for bridge threads |
| `account/read` | Require `account.type === chatgpt`; reject missing/API-key accounts |
| `thread/start`, `thread/resume` | Persist and reuse the project thread ID; verify working directory |
| `thread/read` | Read completed original turns for restart recovery; never silently fork |
| `turn/start` | Exact instruction, client message UUID, explicit cwd and sandbox |
| `item/*`, `turn/*`, errors | Persist raw notifications and correlate completion to the active thread/turn |
| `turn/interrupt` | Best-effort cancellation on pause, timeout or human approval boundary |
| Server approval requests | Persist and decline, then interrupt; bounded local edits are optional |

Completion may arrive before the RPC acknowledgement. The client buffers and correlates it rather than losing the final event. Unknown server requests are refused and treated as a human boundary. All tool items remain in artifacts; executed commands retain exit codes and aggregated output. A failed turn is reported to ChatGPT with its error. Process/RPC failures stop for reconciliation.

`bridge auth codex` invokes the pinned client's official login flow. `--device-auth` uses its device flow. The adapter strips API-key/token environment variables and checks account mode. It forces the `openai` provider, disables web search/app tools and explicitly disables discovered MCP servers for bridge threads. Normal host Codex configuration and credentials remain a trust boundary; see SECURITY.md.

The child lives for the duration of the CLI action. Durable server threads outlive that process. A future daemon can retain the same adapter instance for multiple turns without changing the orchestrator interface.

## Validation

```sh
npm run smoke:codex
npm run smoke:codex-live
```

The first is a connection/authentication check with no model turn. The second uses subscription allowance for a tiny **no-tool** reply and checks same-thread resumption. It writes its report under `.local/codex-live-smoke/`. Neither touches ChatGPT browser conversations or Daily Line.

The initially installed global client, 0.148.0, connected but could not use the account's configured model. The pinned client completed the live test. No global client was upgraded and no alternate model was selected.

## Adapter boundary

`CodexAdapter` separates process details from orchestration. Only `AppServerCodexAdapter` is implemented. A CLI/Exec adapter was unnecessary once App Server worked and is deliberately not presented as a functional fallback. There is no automatic mechanism switch on failure.
