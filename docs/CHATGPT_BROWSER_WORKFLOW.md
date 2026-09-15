# ChatGPT browser workflow

## Transport choice and trust

`BrowserChatGPTAdapter` is a **durable courier adapter**, operated through GrokBot's native persistent browser tools. The bridge does not launch Chromium, fetch ChatGPT backend endpoints, inspect cookies, or call an OpenAI model API. No official GrokBot browser SDK/endpoint is assumed.

GrokBot supplies observed URL/title/message identifiers through a receipt. The CLI validates that receipt against the pinned project and pending request; it cannot prove that the operator actually observed the browser. The operator is therefore a trusted part of the transport. Never manufacture a receipt to make a test pass. Browser integration remains unverified until the real smoke test succeeds.

## Login

Use the normal ChatGPT login in GrokBot's existing persistent browser. The user takes over for passwords, passkeys, MFA and CAPTCHA. If logged out, a missing thread, changed page, rate limit, interrupted response or uncertain identity prevents reliable reading, stop with the applicable reason. Never create a new conversation or switch to an API.

## One handoff

1. `bridge outbox daily-line --output handoff` exports a JSON packet and exact UTF-8 message file. Inspect `status`, `target_url`, `target_title`, `message_sha256` and request ID. Exporting is read-only and **does not authorize a resend**.
2. Navigate to `target_url` in the existing browser. Read the full current URL and visible conversation title, not a remembered title. Confirm existing history is visible and the page is authenticated. If a project view hides the title or message identity, stop for human assistance.
3. Capture the previous completed assistant message's stable identifier. Prefer an actual message ID exposed by supported browser tools. If unavailable, save the full observed message text to a file and run `bridge fingerprint --file previous-assistant.txt`; use that `sha256:...` identifier consistently. An existing architecture thread must have observable prior history.
4. Check that no user message already contains this exact request ID. Claim before posting:

```sh
bridge browser claim daily-line --observed-url "EXACT_URL" --title "EXACT_VISIBLE_TITLE" --baseline "PREVIOUS_ASSISTANT_ID"
```

5. Recheck URL and title immediately before the send. Copy the exact message file into ChatGPT and submit once. Do not rewrite it, evaluate its contents as shell commands, or post it to another conversation.
6. Confirm the new user message exists in that same conversation. Save its observed full text and stable ID (or fingerprint). Optionally record the successful send immediately:

```sh
bridge browser sent daily-line --observed-url "EXACT_URL" --title "EXACT_VISIBLE_TITLE" --message-id "USER_MESSAGE_ID"
```

7. Wait for the response to finish. Confirm generation has stopped, the response directly follows that user message, and the response includes the matching `BRIDGE_REQUEST_ID`. Save the **entire** response and its message ID/fingerprint, not just the footer. If loading stalls or a limit/error appears, pause and notify the user.
8. Construct a UTF-8 JSON receipt from these observations. Use JSON serialization or a text editor, never interpolate the raw content into a shell command. Example shape:

```json
{
  "request_id": "OUTBOX-REQUEST-ID",
  "observed_url": "https://chatgpt.com/c/EXACT-CONVERSATION-ID",
  "observed_title": "Exact visible title",
  "user_message_id": "OBSERVED-USER-MESSAGE-ID-OR-FINGERPRINT",
  "observed_user_message": "Full actual user message copied from the browser",
  "response_id": "NEW-ASSISTANT-MESSAGE-ID-OR-FINGERPRINT",
  "response": "Full raw completed ChatGPT response, including footer",
  "captured_at": "2026-09-15T18:00:00.000Z",
  "response_complete": true,
  "response_follows_user_message": true
}
```

Use the real capture time. `observed_user_message` must match the exported message exactly; if the UI changes whitespace, inspect the discrepancy instead of forging matching text. Do not set either boolean true until actually observed.

```sh
bridge browser receive daily-line --file receipt.json
bridge status daily-line
```

9. If ready, `bridge continue daily-line` relays the instruction. If waiting, paused, failed or complete, follow that stop. Receiving a response never automatically starts code execution.

## Crash or uncertain send

A claimed handoff stays claimed across restarts. Never claim or send it again just because the page refreshed. Run `bridge recover daily-line`, inspect the exact thread for its request marker, and import the existing completed response. A receipt can reconcile a claimed send even if `browser sent` was never recorded.

If no matching posted message can be established, stop for human reconciliation. V0 intentionally has no "reset claim and resend" command. After inspecting browser/Codex/repository state, the human may cancel the run and start a new one; cancellation itself does not undo any external action.

If a captured response has an invalid footer, it is retained in raw artifacts. A human can provide a correction request using `bridge resume daily-line --decision-file clarification.txt`. The bridge returns that clarification to the same ChatGPT conversation; it never invents the instruction.
