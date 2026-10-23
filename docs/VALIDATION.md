# Validation evidence for 0.2.0

Local verification completed on 2026-10-23 using Node.js 24.19.0 on Windows.

- **Automated tests:** 64 cases; 63 passed, 0 failed, 1 filesystem/platform-specific case skipped on Windows. Coverage includes HTTP authentication, malformed requests, workspace identities, path traversal, symlinks/junctions, hard links, sensitive content, bounded ignore-file reads, concurrent editor changes, local terminal approval, permission revocation and window-token isolation. New checks cover metadata-first editor context, captured selections, provider timeouts and response budgets, mixed line endings, UTF-16 positions, malformed Unicode, overlapping ranges, unique matches and preview-only patches.
- **Real extension host:** 15 checks passed in an isolated VS Code 1.144.0-insider profile and disposable workspace, using an official MCP SDK client. Checks cover activation, read-only authenticated startup, rotation, shutdown, live editor reads, denied writes, diff preview, hash-checked editing, stale edits, file creation, relative diagnostics and old-session rejection, plus explicit selection reads, the real hover-provider API, default-preview literal replacement and range patches. Hover integration registers a deterministic test provider; availability and quality of other installed language services remain provider-dependent.
- **Documentation images:** the control-panel and session-access images are actual screenshots of this extension's isolated development profile and a purpose-built synthetic project. They were inspected before saving; no user projects, tokens or unrelated windows were included. The hero and workflow are original SVG illustrations and are labeled separately.
- **Privacy:** source and decompressed VSIX contents are scanned before publication. The package includes the runtime bundle, icon, localized manifest strings, documentation and license notices. Private deployment configuration, user workspace contents, credentials and logs are excluded.
- **Dependencies:** the installed lockfile completed `npm audit --audit-level=high` with no reported vulnerabilities at verification time. This is time-specific, not a permanent security guarantee.

The existing VS Code installation was locked by its updater, so testing used a separate official Insiders runtime. Existing user settings, extensions and the earlier bridge installation were not changed.

## Limits

The automated extension-host checks are not a complete manual keyboard/screen-reader acceptance test. Local terminal approval behavior is covered with controlled host tests; no real user credential or production command was used for testing. Windows, Linux and macOS test/build/package/privacy checks, plus a Linux extension-host test, run in [GitHub Actions](https://github.com/Yari-tuber/vscode-workspace-bridge-mcp/actions/workflows/ci.yml). Refer to the run for the release commit for those results; native macOS editor interaction is not claimed.

Tests and scanners do not prove the absence of every vulnerability or establish whether an earlier deployment leaked data. See the threat model and security policy for the boundaries of file filtering and approved terminal execution.
