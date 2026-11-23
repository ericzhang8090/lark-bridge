# Codex CLI deployment implementation plan

**Goal:** Deploy the existing Codex Lark bridge with independent conversations and provide a reproducible Git version.

**Architecture:** Keep the current Node bridge, `lark-cli` event subscription, isolated `CODEX_HOME`, and per-chat session resumption. Add a read-only prerequisite check before subscribing, Codex-specific setup instructions, and version packaging. Desktop Codex conversations remain independent.

**Tech stack:** Node.js built-ins, PowerShell, existing Lark CLI and Codex CLI. No new npm dependencies.

**Constraints:** Modify the Codex checkout only. Preserve existing Claude/Gemini processes. Never commit config.json, login credentials, runtime state, downloaded files or logs. Do not start a second consumer for an existing application's messages. Release branch: `codex/lark-cli-deployment`; version: `2026.11.24-codex.1`.

## Tasks

- [ ] Test missing profile, missing credentials, unavailable CLI, unsuccessful login status, and successful readiness.
- [ ] Add `codex-preflight.js` and call it before launching the event consumer. Fail with actionable guidance instead of retrying a nonexistent profile indefinitely.
- [ ] Add Codex configuration/persona examples, version metadata and deployment instructions. Correct the background-launch hidden-window setting.
- [ ] Run all Node tests and syntax checks, then copy reviewed source changes into the existing Codex checkout on its own branch.
- [ ] Commit/tag, push the version branch, and package tracked files only. Record remaining interactive Lark/Codex login steps without claiming live deployment success.

## Review focus

Unknown app profiles must not silently fall back to another bot. Login checks must use the isolated bridge environment. Failed prerequisites must prevent event subscription. Release archives must exclude private runtime data. Existing chat-session isolation and other agents must be preserved.
