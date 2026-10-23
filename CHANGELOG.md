# Changelog

## 0.3.0

- Expanded from 15 to 27 tools: batch file reads, workspace symbols, type/implementation navigation, local file review, safe directory creation, saved text-file moves, confirmed Trash operations, and asynchronous command tasks.
- Added a bilingual, theme-aware control center with searchable tools, permission status, task cancellation and metadata-only activity. Kept the compact native sidebar.
- Background commands require local approval, support status/output queries and cancellation, and keep process slots occupied until the actual child exits. Three-active-task, ten-minute and output budgets apply.
- File lifecycle operations check current editor and disk state. They reject dirty files and overwrites; deletion only requests the system Trash after local per-file confirmation.
- Kept asynchronous operations bound to copied workspace identities, and added bounded/stale-result checks for language navigation.


## 0.2.0

- Added on-demand active editor context. Selection text is excluded unless explicitly requested.
- Added bounded, timeout-controlled hover documentation through VS Code's language service.
- Added hash-guarded range edits and unique literal replacements, both previewing by default. UTF-16 coordinates and mixed line endings are validated; ambiguous, overlapping and malformed Unicode edits are refused.
- Added a token-free starter prompt in the sidebar and command palette.
- Redesigned the English and Chinese READMEs with original diagrams, real screenshots from an isolated synthetic project, a three-step quick start, and a detailed setup guide.
- Documented related open-source projects and the scope of independently implemented improvements.


## 0.1.0 — 2026-10-23

Initial open-source implementation of Workspace Bridge MCP.

- A VS Code extension serving MCP over a loopback HTTP endpoint with the official MCP TypeScript SDK.
- Mandatory bearer authentication with window-specific, reload-scoped tokens stored through VS Code SecretStorage.
- A local control panel, server status, a quick action picker, token rotation, and connection-configuration copying.
- Read access by default, Workspace Trust checks, workspace identity checks, real-path containment, and sensitive-name filtering.
- Session-scoped editing with SHA-256 conflict protection, serialized writes per file, and path rechecks around editor operations; session-scoped terminal access with local approval for each command.
- Permission reset on shutdown and workspace changes; operational diagnostics without workspace contents or tokens.
- English and Simplified Chinese setup documentation, a threat model, remote-access guidance, and a public release checklist.

This release does not automatically publish a remote endpoint or implement an OAuth authorization server. Windows is the current validation platform; macOS and Linux require platform acceptance checks.
