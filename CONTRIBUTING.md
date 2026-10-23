# Contributing

Small, reviewable improvements are welcome. Start with an issue for changes to the permission model, supported transports, terminal execution, or remote access. Report exploitable security problems through [SECURITY.md](SECURITY.md).

## Development

1. Install Node.js and npm versions supported by `package.json`.
2. Clone the repository and run `npm ci`.
3. Run `npm test`, `npm run privacy`, and `npm run build` before preparing a change.
4. Run `npm run test:integration` for extension-host integration checks in an isolated test environment. Test local user interactions separately where needed.
5. Build a VSIX with `npm run package`, then run `npm run privacy -- --vsix artifacts/workspace-bridge-mcp-0.1.0.vsix` and inspect the package contents before distributing it.

Do not develop against a workspace containing real credentials. Use temporary folders with dummy content, including for terminal-approval and path-containment tests. Keep the extension host separate from your regular workspace when testing changes that execute commands or write files.

## Changes that need tests

For security-sensitive changes, cover both the allowed operation and the denied operation. Preserve authentication before tool dispatch, loopback binding, host validation, workspace identity checks, Workspace Trust, sensitive-file denial, real-path containment, write conflict detection, and explicit terminal approval. Test Windows path semantics as well as portable behavior when changing filesystem handling.

Never weaken a boundary merely to make a test pass. A client integration should adapt to the server's constraints and surface useful errors.

For user-interface changes, include a short description or a redacted screenshot. Confirm keyboard access, clear permission labels, and a visible server state. Avoid silently enabling editing or terminal execution.

## Pull requests

Explain the concrete problem, the resulting behavior, and the validation performed. State what was not tested. Update the relevant English and Chinese user documentation when behavior changes. Keep generated bundles and VSIX artifacts out of source changes unless the project explicitly tracks them.

Do not include tokens, local connection configurations, private domains, absolute user paths, terminal transcripts, copied source from other projects, or screenshots of personal workspaces. If using third-party code, preserve its license and attribution and describe the dependency.

## Licensing

By submitting a contribution, you agree that your contribution may be distributed under the project's [MIT License](LICENSE). Only submit material you have the right to license.
