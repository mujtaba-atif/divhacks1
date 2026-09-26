# Project Instructions

## Codex Subagents

The user has requested use of the VoltAgent subagents installed in
`.codex/agents/`. Delegate independently scoped work to relevant specialists
when it improves implementation, investigation, or review. Keep simple tasks
local and select only the profiles relevant to the current request.

- Read the selected profile before using it. Prefer native custom-agent
  selection when available; otherwise give a spawned subagent the profile's
  instructions and an explicit task. Do not claim its TOML settings were applied
  automatically when using this fallback.
- Useful starting roles are `code-mapper`, `frontend-developer`,
  `backend-developer`, `test-automator`, and `reviewer`.
- Give each subagent a bounded scope, clear file ownership when editing, and
  an expected result. Keep review and research assignments read-only.
- Respect the active session's permissions and concurrency limits. Profiles
  do not grant access to missing tools or permission for unrelated actions.
- Wait for delegated results, resolve findings, and run appropriate checks
  before reporting completion.

See `.codex/agents/README.md` for the source revision and setup details.
