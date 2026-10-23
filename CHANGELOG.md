# Changelog

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
