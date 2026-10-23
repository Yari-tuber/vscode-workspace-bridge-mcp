# Release checklist

Use this checklist for the exact commit and VSIX being published. Check a box only after observing the result. A source review, a compiled bundle, and an HTTP health check are useful preflight checks; they do not replace extension-host and client acceptance.

## Release identity

- Version: `0.2.0`
- Repository: [Yari-tuber/vscode-workspace-bridge-mcp](https://github.com/Yari-tuber/vscode-workspace-bridge-mcp).
- Commit: record in the GitHub release.
- Package SHA-256: publish beside the VSIX.
- Validation platform: Windows; record the VS Code and Node.js versions with the release evidence.
- Other targets: macOS and Linux are intended targets and remain unverified until their checks are recorded.

## Repository and package hygiene

- [ ] Verify repository and security-reporting links target `Yari-tuber/vscode-workspace-bridge-mcp`.
- [ ] Confirm publication is authorized for the selected GitHub account and public repository.
- [ ] Inspect the full Git history being pushed, not only the working tree.
- [ ] Scan tracked files, build output, npm lockfile, VSIX contents, documentation, fixtures, and release attachments for credentials and private deployment details.
- [ ] Confirm that no user workspace files, personal domains, local absolute paths, private routing configuration, tokens, environment files, or production logs are included.
- [ ] Inspect third-party licenses and ensure required notices are preserved.
- [ ] Confirm the package includes only intended runtime files, license, notices, and user documentation.
- [ ] Run the repository's declared checks, tests, build, and packaging command on the release commit.
- [ ] Run `npm run verify:package` and manually review the package manifest. A heuristic scan is not a substitute for inspection.
- [ ] Verify the VSIX file name, manifest version, and SHA-256 digest.
- [ ] Enable GitHub private vulnerability reporting and verify the link in `SECURITY.md`.

## Security behavior

- [ ] Requests without a token and with an incorrect token fail before MCP tool execution.
- [ ] The listener binds only to loopback; unapproved host values are rejected.
- [ ] An untrusted workspace cannot expose file or terminal tools.
- [ ] A mismatching workspace identifier is rejected.
- [ ] Traversal, absolute paths, blocked sensitive names, and symlinks outside the workspace are denied.
- [ ] Read-only defaults reject file mutation and terminal execution.
- [ ] Editing can be enabled locally for the session; a correct hash allows the intended write, while a stale hash preserves the current file.
- [ ] Concurrent writes to the same file are serialized and a stale proposal fails after the current proposal changes that file.
- [ ] Replacing a file or ancestor with a link during asynchronous editor loading is rejected by the later path check.
- [ ] A terminal request does not execute before the local user approves that exact command; rejection executes nothing.
- [ ] Stopping the bridge and changing workspace reset editing and terminal permissions.
- [ ] Token rotation invalidates the previous token and refreshes copied connection settings.
- [ ] Two windows opening the same folder receive different tokens; reload produces a new token, while stop/start within one activation reuses its token.
- [ ] A preferred-port collision produces a working available port without replacing the other listener.
- [ ] Extension diagnostics contain no file contents, terminal output, user absolute paths, bearer tokens, or sensitive request bodies.

## User acceptance

- [ ] Install the packaged VSIX in an isolated VS Code profile or extension-development environment.
- [ ] Open a disposable trusted workspace and use the control panel with keyboard navigation.
- [ ] Start, stop, restart, inspect the workspace, copy connection configuration, and rotate the token.
- [ ] Connect an actual MCP client; discover tools and read a dummy file.
- [ ] Complete one conflict-protected edit and one explicitly approved harmless terminal command; confirm denied cases independently.
- [ ] Check multi-window behavior and stale workspace requests.
- [ ] Verify English and Chinese setup instructions against the released build.
- [ ] Record macOS and Linux results before claiming those platforms are validated.

## Publication

- [ ] Publish source to the authorized public repository with the MIT license and security policy.
- [ ] Create a release for the same commit, attach the inspected VSIX and checksum, and record validation and known limits.
- [ ] Read back the public repository, release text, download, and checksum after publication.
- [ ] Keep evidence free of user content and secrets. State any remaining acceptance gaps explicitly.
