# VoltAgent Codex Subagents

This project includes all 175 agent profiles from
[VoltAgent/awesome-codex-subagents](https://github.com/VoltAgent/awesome-codex-subagents).

- Upstream revision: `7add6913c53ccbbc250c481815c9c6afb02709c6`
- Installed: 2026-09-26
- Scope: this repository, under `.codex/agents/`
- License: MIT; the upstream notice is preserved in `LICENSE`.
- Profile contents are copied unchanged from upstream `categories/*/*.toml`.

## Use

The root `AGENTS.md` requests delegation to relevant specialists. Each TOML
contains its role instructions, model and reasoning settings, and sandbox
preference. Native custom-agent selection applies those settings; reading a
profile into a generic subagent supplies its instructions only, unless settings
are also explicitly selected through supported controls.

Codex supports project-scoped discovery from this directory. Start a fresh
session or refresh Codex if newly installed profiles are not listed. No extra
agent registry or global configuration change is required.

Example request: "Use code-mapper to locate the affected code, then have
reviewer check the change for regressions."

Some profiles include optional MCP server configurations. Installing these
files does not install or authenticate their external tools. Confirm those
tools are available when selecting such a profile.

- `browser-debugger` expects a Chrome DevTools MCP service at
  `http://localhost:3000/mcp`.
- `docs-researcher` connects to `https://developers.openai.com/mcp`.
- `visual-asset-generator` expects `prompt-to-asset`. Its read-only sandbox
  preference conflicts with its package-install and asset-write instructions;
  the parent must handle any permitted writes through available tools.

## Updates

Compare against the recorded upstream revision before updating. Preserve local
changes, validate the TOML files and unique names, retain the upstream license,
and update the revision above with any new import.

Reference: [official custom-agent documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents#custom-agents).
