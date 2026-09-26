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

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
