# Validation evidence for 0.4.0

Local verification completed on 2026-10-23 using Node.js 24.19.0 on Windows.

- **Automated tests:** 190 cases; 189 passed, 0 failed, 1 filesystem/platform-specific case skipped on Windows. These include real temporary Git repositories, hooks/filter/config attack fixtures, refactor plans/conflicts, task approvals and process-tree cleanup, rolling-log secret retention, manifest-bound npm execution, scoped permission expiry/disposal, and dashboard isolation. The final small fixture/CSS follow-up passed 22 relevant cases.
- **Real extension host:** 36 checks passed in isolated VS Code 1.144.0-insider, using disposable workspaces and official MCP SDK clients. New checks exercise real multi-file provider edits, formatting, safe CodeActions, dirty-buffer and conflict behavior, passing/failing npm TAP jobs, same-task session approval, manifest changes, and the complete Git stage/review/commit/unstage workflow. Test-only modal responses are controlled fixtures, not a production bypass. Language checks use deterministic registered providers; other languages remain provider-dependent.
- **UI and documentation:** the v0.4 screenshots show the actual running control-center webview in a synthetic workspace. Six capability states, tool counts, tool filtering and desktop layout were inspected in the editor. Older v0.2/v0.3 screenshots remain explicitly labeled where retained. No user project, secret or unrelated window is included.
- **Privacy:** all intended publication source files and decompressed VSIX contents are scanned before publication, including newly added files. Private deployment state, user project data, credentials and local logs are excluded. Heuristic scanners do not prove that every secret or vulnerability is absent.
- **Package:** the inspected VSIX and SHA-256 are published with the release. CI rebuilds and packages the exact release commit after its test matrix passes. Follow the public release-commit workflow for the final cross-platform results.

The user's normal editor configuration, installed bridge and existing services were not replaced. The package is tested in an isolated profile.

## Limits

This is not an independent penetration test or a common usability benchmark against competing products. Native macOS editor interaction, full screen-reader acceptance, arbitrary language extensions and every npm reporter are not claimed. Git supports self-contained repository roots with conservative restrictions and local identity; it bypasses hooks, signing, filters and line-ending conversion. Refactors leave editor buffers unsaved. A supported TAP report is project-produced data, not independent proof that tests are meaningful. Approved tasks run with the user's filesystem/network privileges and are not sandboxed.

Windows, Linux and macOS test/build/package/privacy checks and a Linux extension-host test run in [GitHub Actions](https://github.com/Yari-tuber/vscode-workspace-bridge-mcp/actions/workflows/ci.yml). Source/package/runtime evidence cannot establish whether an earlier private deployment leaked data.
