# Security policy

## Supported versions

Security fixes are developed for the latest released version. Version 0.1.0 is an early release; do not assume an independent security certification or a guarantee that every vulnerability has been found.

## Report a vulnerability privately

Use [GitHub private vulnerability reporting](https://github.com/Yari-tuber/vscode-workspace-bridge-mcp/security/advisories/new) when it is enabled. If that route is unavailable, open an issue asking for a private reporting channel **without including the vulnerability, exploit, logs, tokens, or user data**. Do not post a working vulnerability in a public issue while arranging disclosure.

Include the affected version, operating system, a minimal reproduction in a disposable workspace, expected and actual behavior, and an assessment of the affected boundary. Use invented file names and dummy data. Remove bearer tokens, local paths, repository names, terminal output, source contents, and client credentials from attachments.

There is no promised response time or bug bounty. Coordinated disclosure is appreciated.

## Security boundaries

- The HTTP server listens on the loopback interface and requires a bearer token stored through VS Code SecretStorage. Every window activation uses a fresh random namespace and token, including windows opening the same folder. Stopping and restarting within that activation reuses the token; rotation, workspace change, or window reload invalidates the old connection. Normal deactivation removes the current SecretStorage entry. Anyone with a valid token and access to its endpoint can invoke the tools allowed for that session.
- Workspace Trust and explicit local controls gate access. Paths are resolved against real workspace roots; symbolic links, junctions, multi-link files, common sensitive names, and recognizable credential patterns are denied. Paths are checked again after asynchronous editor loading and around writes. These checks are not OS-level isolation against a malicious local process rapidly swapping filesystem entries.
- Read access is the default. Editing requires a session switch and a SHA-256 match against the current file before an existing file can be replaced. A per-file mutex serializes writes within one bridge instance, with content/version checks repeated before applying an edit; it does not lock out other programs.
- Terminal access requires a session switch and a separate local approval for each command. It runs with the permissions of the VS Code user. **It is not a sandbox.** An approved command can read or change files outside the workspace and use the network.
- Session permissions reset when the server stops or the workspace changes. Requests must identify the active workspace; a mismatching workspace identifier is rejected.

Sensitive-name and content filtering cannot recognize every secret. Once an allowed file or terminal result is returned to a client, the client's own storage, logging, model-provider, and retention policies apply. The extension cannot retract that data.

## Remote access

Remote publishing is not automatic. A remote deployment needs a user-managed TLS reverse proxy or tunnel, an explicit allowed-host configuration, and bearer authentication. Avoid exposing the VS Code endpoint directly to the Internet. See [remote access](docs/REMOTE-ACCESS.md) for the required boundaries and compatibility limits.

This version is a bearer-authenticated server, not an OAuth authorization server. Do not assume compatibility with a hosted connector that cannot send custom authorization headers.

## Privacy and diagnostics

The project does not collect telemetry or automatically create a tunnel. Its local activity log and exported bridge diagnostics contain operational metadata rather than file contents, terminal output, bearer tokens, or user absolute paths. The `get_diagnostics` tool is separate: it intentionally returns requested editor messages to the client. Review any client logs, reverse-proxy logs, screenshots, and manually copied information before sharing them. The **Copy Token** and connection-configuration actions intentionally place a secret on the clipboard.

See the [threat model](docs/THREAT-MODEL.md), [public audit notes](docs/SECURITY-AUDIT.md), and [release checklist](docs/RELEASE-CHECKLIST.md). Those documents describe the design and verification scope; they cannot establish whether a previous installation ever disclosed data.
