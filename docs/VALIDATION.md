# Validation evidence for 0.3.0

Local verification completed on 2026-10-23 using Node.js 24.19.0 on Windows.

- **Automated tests:** 135 cases; 134 passed, 0 failed, 1 filesystem/platform-specific case skipped on Windows. These cover HTTP/authentication and workspace security, editor hashes and precise edits, batch read budgets, language-service navigation, saved-file lifecycle guards, Trash approval, task approval/cancellation/process cleanup, cross-session concurrency accounting and dashboard message/state isolation.
- **Real extension host:** 21 checks passed in an isolated VS Code 1.144.0-insider profile and disposable workspace with official MCP SDK clients. New acceptance covers the actual control-center webview, batch reads, registered workspace/type/implementation providers, real directory creation and non-overwriting file moves, local file review, and a completed command task queried over MCP. Controlled test-only local approval is injected for the synthetic echo command; it is not a production bypass. Language integration registers deterministic providers; other installed language services remain provider-dependent.
- **Documentation images and interaction:** the v0.3 control-center and tool-directory screenshots show the actual running webview in a synthetic workspace. Search filtering and visible read/edit/terminal states were inspected in the editor. The older control-panel/session-access images remain labeled v0.2. No user projects, tokens or unrelated windows were included. The hero and workflow are original illustrations.
- **Privacy:** source and decompressed VSIX contents are scanned before publication. The package includes the runtime bundle, icon, localized manifest strings, documentation and license notices. Private deployment configuration, user workspace contents, credentials and logs are excluded.
- **Dependencies:** the installed lockfile completed `npm audit --audit-level=high` with no reported vulnerabilities at verification time. This is time-specific, not a permanent security guarantee.

The existing VS Code installation was locked by its updater, so testing used a separate official Insiders runtime. Existing user settings, extensions and the earlier bridge installation were not changed.

## Limits

The automated extension-host checks are not a complete manual keyboard/screen-reader acceptance test. Trash behavior is tested with synthetic VS Code adapters, including explicit local approval and useTrash-only assertions; no user file was moved to the system Trash. Terminal approvals and process-tree cleanup are tested with controlled fixtures; no real credentials or production commands were used. Windows, Linux and macOS test/build/package/privacy checks, plus a Linux extension-host test, run in [GitHub Actions](https://github.com/Yari-tuber/vscode-workspace-bridge-mcp/actions/workflows/ci.yml). Refer to the run for the release commit for those results; native macOS editor interaction is not claimed.

Tests and scanners do not prove the absence of every vulnerability or establish whether an earlier deployment leaked data. See the threat model and security policy for the boundaries of file filtering and approved terminal execution.
