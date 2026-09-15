# Troubleshooting

| Stop / symptom | Next action |
| --- | --- |
| `CHATGPT_BROWSER_UNAVAILABLE` | Restore GrokBot browser access; no API fallback exists |
| Logged out / MFA / CAPTCHA | User takes over the existing browser; do not automate security steps |
| Thread missing / `WRONG_CHATGPT_THREAD` | Confirm the exact configured URL and pinned visible title; never send elsewhere |
| ChatGPT page changed / response interrupted / rate limit | Pause; inspect the page with the user; do not import partial text |
| `STALE_CHATGPT_RESPONSE` | Check request UUID, message identity and actual capture time; do not edit old data to look fresh |
| `OUTBOUND_MESSAGE_MISMATCH` | Compare the actual posted text to the outbox; no paraphrasing or fabricated receipt |
| `SEND_ALREADY_CLAIMED` | Inspect the original conversation for the posted request and reconcile |
| `DUPLICATE_CHATGPT_RESPONSE` | Read the actual new assistant response after this request; no reusing prior text |
| `AMBIGUOUS_CHATGPT_DECISION` | Preserve raw response; human asks for corrected footer via decision file |
| `CODEX_CHATGPT_LOGIN_REQUIRED` | Run `bridge auth codex` on the same host; API-key login is refused |
| Codex usage limit / network error | Inspect raw turn error; wait for the account/network recovery, then obtain ChatGPT's next decision |
| Model requires a newer Codex version | Update the pinned dependency deliberately and repeat protocol/live smoke checks; do not silently change models |
| `CODEX_PROCESS_CRASH`, `CODEX_TURN_TIMEOUT` | `bridge recover PROJECT`; never blindly repeat the instruction |
| `CODEX_APPROVAL_REQUIRED` | Inspect exact stored request; user resolves boundary; recover interrupted evidence |
| `CODEX_RECONCILIATION_REQUIRED` | Original turn is active or unavailable; inspect original Codex thread/process |
| `UNCERTAIN_CODEX_SEND` | Intent exists but remote ID was not recorded; human inspects Codex history before any next work |
| Codex thread unavailable | Stop. Restore its normal Codex storage/account; no silent fresh thread |
| `WRONG_REPOSITORY`, `WRONG_CODEX_REPOSITORY` | Check canonical root and registered origin; never reuse an unrelated thread |
| `WRONG_BRANCH` | Select the registered isolated branch after preserving current work |
| `DIRTY_WORKING_TREE` | Commit/stash existing work manually before starting a new run |
| `GIT_CONFLICT`, `GIT_OPERATION_IN_PROGRESS` | Human reconciles the in-progress Git operation; never auto-resolve architecture conflicts |
| Tests/build fail | Review the exact exit code and output in ChatGPT; failure is evidence, not completion |
| `EVIDENCE_TOO_LARGE`, `EVIDENCE_REQUIRES_HUMAN_REVIEW` | Export full artifacts and arrange human-reviewed transport; no silent truncation |
| `UNAUTHORIZED_REPOSITORY`, `REPOSITORY_DISABLED` | Inspect user-registered catalog and run scope; never add/enable a repo to satisfy a model request |
| `UNKNOWN_WORKSTREAM`, `WRONG_WORKSTREAM` | Ask ChatGPT for the correct registered route after human resolves the stop; never invent IDs |
| `MULTI_REPO_TURN_UNSUPPORTED` | One repository per turn; request a bounded routed instruction, never auto-split |
| `WORKSTREAM_IDENTITY_CHANGE`, `WRONG_CODEX_THREAD` | Restore original workstream/thread context; do not replace it |
| `STATE_MIGRATION_REQUIRED`, `MIGRATION_REVIEW_REQUIRED` | Follow the backed-up schema-2 migration in Operations; reconcile old external work before cancellation/new run |
| `REPOSITORY_REVIEW_REQUIRED` | Supply migrated repository default_branch through `repo update` while idle |
| `REPOSITORY_PATH_OVERLAP`, `STATE_REPOSITORY_OVERLAP` | Use separate canonical checkouts with private state outside all repositories |
| `DUPLICATE_RUN`, `PROJECT_BUSY` | Inspect existing run/controller; pause or recover instead of launching another |
| `LOOP_LIMIT`, `CONTROLLED_TEST_COMPLETE` | Show summary; obtain explicit human continuation authorization |
| Node SQLite experimental warning | Expected on tested Node 24.11.1; the test suite exercises the actual SQLite implementation |

For an unresolved exception, use `bridge status`, `bridge logs --run ID`, and `bridge artifacts --run ID --output DIR`. Inspect private raw artifacts locally; share only after reviewing them for secrets. Operational logs redact common token forms, but arbitrary sensitive source output cannot be reliably detected.
