# Quickstart

## 1. Put the bridge on GrokBot's computer

Copy this source checkout to the Bot's persistent filesystem. Use Node.js 24.11+ (tested on 24.11.1) and Git. Commands are cross-platform unless marked otherwise.

```sh
git clone --branch bridge/mvp https://github.com/OneVillage83/GrokBot-OpenAI-Bridge.git
cd GrokBot-OpenAI-Bridge
npm ci
npm run build
npm test
npm link
bridge init
```

On the current Windows machine:

```powershell
Set-Location -LiteralPath 'E:\GrokBot OpenAI Bridge'
npm ci
npm run build
npm link
bridge init
```

State defaults to `~/.grokbot-openai-bridge/bridge.sqlite`. Use `BRIDGE_HOME` or `--data-dir` to choose a private directory **outside the managed repository**. There is no background process to install; GrokBot calls the CLI as it coordinates. Do not put the database or credentials in Git.

A prebuilt local package can also be created with `npm run build` then `npm pack`. Copy that `.tgz` file to GrokBot's computer and run `npm install -g /path/to/grokbot-openai-bridge-0.2.0.tgz`, then `bridge init`. The package contains the compiled CLI, skill and documentation; source tests are run from the source checkout.

Existing schema-1 state requires `bridge migrate` before `init` or project commands. Stop all controllers and follow [Operations](OPERATIONS.md#schema-1-to-2-migration); do not overwrite or re-register an existing project.

## 2. Authenticate both systems

**ChatGPT:** tell GrokBot to open the exact existing conversation in its persistent browser. Take over its computer for passwords, passkeys, MFA or CAPTCHA, then return control. Do not send passwords in chat or export browser cookies.

**Codex:** on GrokBot's computer run:

```sh
bridge auth codex
```

Choose Sign in with ChatGPT. If the browser callback cannot reach the host:

```sh
bridge auth codex --device-auth
```

The official Codex client owns authentication. Existing normal Codex login is reused on that computer. No `OPENAI_API_KEY` is required or accepted as a substitute.

## 3. Configure The Daily Line

Copy `config/daily-line.example.json` to a private `daily-line.json`. Set:

| Field | Value to supply |
| --- | --- |
| `chatgpt_thread_url` | Exact existing `https://chatgpt.com/c/...` or project `https://chatgpt.com/g/.../c/...` URL |
| `chatgpt_thread_title` | Exact visible conversation title; GrokBot must inspect it |
| `repositories[].repo_url` | Exact Git origin URL without embedded credentials |
| `repositories[].repo_path` | Absolute path on GrokBot's computer; Windows JSON needs escaped backslashes or `/` |
| `repositories[].working_branch` | `bridge/daily-line-agent-1`, or your task branch |

The v2 config has `repositories` and `workstreams` arrays. Keep only repository ID `The-Daily-Line-Automation` and workstream `automation-agent-1` for this first test. Supply its actual `default_branch` (do not assume main), logical name, role and `enabled: true`. Set the workstream's `repository_id` to that exact ID; omit `codex_thread_id`, which is assigned durably by the bridge. Paths must be absolute, non-overlapping and outside the bridge's private state directory. Legacy single-repository JSON is rejected.

The Daily Line remains one project; additional repositories/workstreams can be registered later by the user. ChatGPT chooses the route from the catalog. GrokBot cannot register model-requested repositories or broaden a run's target set.

Do not paste or encode Daily Line architecture in this file. The registry deliberately does not contain it. The 5-turn default applies only after controlled-test enablement; the first run always allows one turn.

```sh
bridge project add --file daily-line.json
bridge repo prepare daily-line --repository The-Daily-Line-Automation --clone
bridge project show daily-line
bridge doctor daily-line
```

The clone parent directory must already exist. Git uses the host's normal credential helper and stops if access is unavailable. `repo prepare` refuses dirty trees; manually preserve existing work first. It creates/selects the isolated branch. An existing record cannot be overwritten through `project add`; repository metadata can be updated while idle; checkout/origin/branch and workstream/thread identities cannot be rebound. See Operations.

Doctor verifies SQLite, skill presence, App Server/authentication, repository origin/root/branch/conflicts and clean state. Browser readiness remains explicitly unknown because the CLI cannot see GrokBot's browser. This produces exit code 2 until that external requirement is independently addressed; it does not imply the other checks failed.

## 4. Teach GrokBot

Provide `skills/grokbot-openai-bridge/SKILL.md` and the documentation folder. Ask it to save these instructions as **GrokBot OpenAI Bridge**. See [installation details](GROKBOT_SKILL.md). Tell it where the CLI and private state directory are installed.

## 5. First controlled live test

1. Inspect the repository and confirm that the configured branch is clean and not main.
2. Open the exact configured ChatGPT conversation. Verify its full URL and visible title.
3. Run `bridge start daily-line --repositories The-Daily-Line-Automation --task "Continue DL-Agent-1."`.
4. Run `bridge outbox daily-line --output handoff`.
5. Follow [the browser handoff procedure](CHATGPT_BROWSER_WORKFLOW.md): claim once, post the exact message, capture the completed assistant response, import its receipt.
6. Inspect `bridge history daily-line` and the received instruction. Verify the parsed target is `The-Daily-Line-Automation` with workstream `automation-agent-1`. If the status is `READY_FOR_NEXT_CODEX_TURN`, run `bridge continue daily-line`. The bridge sends that exact instruction to Codex.
7. Wait for the command to finish. It persists Codex events, final result and Git evidence. Any approval request stops for human handling; run `bridge recover daily-line` after inspecting the interrupted turn.
8. If the run is `WAITING_FOR_CHATGPT`, perform the new outbox handoff to the **same** ChatGPT thread. It contains code/test/diff evidence keyed by repository, bounded new-file UTF-8 contents and completed Codex patches. Binary entries carry metadata. An oversized or unsafe evidence stop requires private artifact review; never send a shortened packet to bypass it. Import the review response.
9. Stop. A continuation decision leaves the run `PAUSED`; a completion decision leaves it `COMPLETED`. Show the user the two ChatGPT exchanges, exact Codex instruction/result, command outputs, Git diff, and final review decision. Never call another development turn in this controlled test.

```sh
bridge status daily-line
bridge history daily-line
bridge logs --run RUN_ID
bridge artifacts --run RUN_ID --output review-artifacts
```

The export index maps each database artifact to its run, turn, kind and timestamp; `raw-snapshots/` includes per-repository file/Git captures. All exports may contain secrets and must stay private. Original absolute snapshot paths remain provenance pointers; copied snapshots retain the same run/turn/repository directory structure.

## 6. Enable more turns only after human review

```sh
bridge project enable-autonomy daily-line --acknowledge
```

This requires the persisted successful one-turn Codex completion **and** a parsed ChatGPT review. It cannot be enabled by a project config field. If the controlled run paused with a next instruction:

```sh
bridge resume daily-line --additional-turns 1
bridge continue daily-line
```

If it completed, start a new task. GrokBot continues the browser/CLI loop until completion, human stop or the configured limit. Each additional budget on an existing run requires explicit human authorization.
