# Workspace Bridge MCP

<img src="media/icon.png" width="88" height="88" alt="Workspace Bridge MCP: connected code brackets" />

[![Verify](https://github.com/Yari-tuber/vscode-workspace-bridge-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Yari-tuber/vscode-workspace-bridge-mcp/actions/workflows/ci.yml) · [MIT license](LICENSE) · [Validation evidence](docs/VALIDATION.md)

[English](README.md) · [简体中文](README.zh-CN.md) · [Security](SECURITY.md)

Let an MCP client work with the folder open in VS Code. Read project files, inspect diagnostics, and make deliberate edits from your AI tool, while keeping permission controls in the editor.

The bridge starts with read access. Editing and terminal execution require local session controls; each terminal command also needs local approval. The server listens on loopback, requires a bearer token, and does not automatically publish a tunnel or collect telemetry.

The icon joins code brackets with a bridge stroke: the editor and your AI client are connected through one controlled workspace boundary.

Version **0.1.0** is an early release. Windows is the current validation platform. macOS and Linux are intended targets; their acceptance checks remain unverified. See the [release checklist](docs/RELEASE-CHECKLIST.md) for the scope of release evidence.

## What you can do

| Task | How access is controlled |
| --- | --- |
| Identify the active workspace and discover its capabilities | Explicit workspace identity; stale or mismatching workspace requests fail. |
| List, search, and read project files | Workspace Trust, workspace-root containment, sensitive-name filtering, and size limits. |
| Read VS Code diagnostics | Returns the editor's existing diagnostics; it does not install or run a language server. |
| Create or update a project file | Enable editing locally for this session; updates require a matching SHA-256 digest. |
| Run a terminal command | Enable terminal access for this session, then approve that specific command in VS Code. |
| Manage the connection | Local control panel, action picker, status bar, token rotation, and connection-configuration copying. |

Use [the tool reference](docs/TOOLS.md) for tool names, parameters, and the recommended read–edit sequence.

## Install and connect

1. Download the `.vsix` from [GitHub Releases](https://github.com/Yari-tuber/vscode-workspace-bridge-mcp/releases). Verify its SHA-256 against the release checksum.
2. In VS Code, open **Extensions → … → Install from VSIX…** and select the file.
3. Open a folder you trust. Select **Workspace Bridge** in the Activity Bar and choose **Start bridge**. You can also run **Start Bridge** (`workspaceBridge.start`) from the Command Palette.
4. Confirm the displayed workspace and use the panel to copy the connection configuration. The actual port can change if the preferred port is occupied.
5. Add the configuration to a trusted MCP client that supports **Streamable HTTP** and an **Authorization header**. Connect and begin with a read of a disposable file.

Copied connection configuration contains a bearer token. Store it in the client's protected settings, keep it out of repositories and chat messages, and review clipboard-history settings. Each VS Code window has its own token, including when two windows open the same folder. Reloading or reopening the window creates a new token; copy the configuration again.

Client schemas differ. The connection values have this shape; use the panel's copied values for your running instance:

```json
{
  "mcpServers": {
    "workspace-bridge": {
      "type": "http",
      "url": "http://127.0.0.1:<PORT>/mcp",
      "headers": {
        "Authorization": "Bearer <TOKEN>"
      }
    }
  }
}
```

`<PORT>` and `<TOKEN>` are placeholders. Some clients use a different transport label or configuration structure. A stdio-only client cannot use this endpoint directly. This release does not implement OAuth, so a hosted connector requiring OAuth or lacking custom-header support may be incompatible.

## Use editing and terminal access deliberately

For an edit, first read the file and keep the returned SHA-256. Enable editing in the local panel, then submit the replacement with that hash. Writes to the same file are serialized within the bridge and recheck the current content before applying. If the file changed, read it again and reconcile the change. Do not blindly retry with a new hash.

Terminal execution starts disabled. After you enable it, the editor shows a local approval for every command. Review the command and working directory before approving. The command uses the system shell and your operating-system account's permissions; **this is not a sandbox**. It can access files outside the workspace and use the network.

Editing and terminal permissions reset when the server stops or the workspace changes. Stopping and restarting the bridge in the same window reuses its token; rotation revokes it immediately. Reloading the window or changing workspaces creates a new token. Normal extension shutdown deletes the current SecretStorage entry. Update saved client configurations whenever the token changes.

## Privacy and security

- The bearer token is stored through VS Code SecretStorage. Copying it or the connection configuration intentionally exposes it to your clipboard and chosen client.
- File tools resolve workspace-relative paths against the real filesystem and reject symbolic links, junctions, and files with multiple hard links. Paths are rechecked after asynchronous editor loading and around edits. These checks reduce risk but do not provide OS isolation from a malicious local process rapidly replacing filesystem entries. Common sensitive names and recognizable credential patterns are denied; these checks cannot detect every secret.
- The local activity log and exported bridge diagnostics contain operational metadata, excluding file contents, terminal output, bearer tokens, and user absolute paths. Requested code diagnostics are separate tool results containing editor messages.
- Files and command results returned to an MCP client are subject to that client's logging, model-provider, and retention policies.
- Remote access requires your own TLS forwarding layer, allowed-host configuration, and bearer authentication. See [remote access](docs/REMOTE-ACCESS.md) before exposing an endpoint.

Read the [security policy](SECURITY.md), [threat model](docs/THREAT-MODEL.md), and [audit notes](docs/SECURITY-AUDIT.md). A clean scan and passing tests cannot prove that every vulnerability is absent or that an earlier installation never disclosed data.

## Build from source

Use the Node.js and npm versions supported by `package.json`:

```sh
git clone https://github.com/Yari-tuber/vscode-workspace-bridge-mcp.git
cd vscode-workspace-bridge-mcp
npm ci
npm test
npm run privacy
npm run build
npm run test:integration
npm run package
```

Requires **VS Code 1.96 or newer**; source builds require **Node.js 22 or newer**. The integration script uses an isolated VS Code profile and temporary workspace. It downloads a VS Code test build unless `VSCODE_EXECUTABLE` points to an existing executable. The packaged extension is written to `artifacts/workspace-bridge-mcp-0.1.0.vsix`. Use a disposable workspace containing dummy data for development and acceptance.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and review expectations.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `workspaceBridge.autoStart` | `false` | Start automatically in a trusted workspace. Permission switches still begin disabled. |
| `workspaceBridge.port` | `3338` | Preferred local port. If occupied, the next nine ports are tried. Use `0` to request an available port. |
| `workspaceBridge.allowedHosts` | `[]` | Additional exact hostnames for user-managed forwarding, without scheme, port, or wildcard. Local loopback access remains available. |

These are machine-scoped settings. Editing and terminal grants are session controls in the local panel, rather than persistent workspace settings.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| The client cannot connect | Confirm the bridge is running. Copy the configuration again to obtain the current port. Confirm the client supports Streamable HTTP. |
| Authentication fails | Use the configuration for this window. Recopy it after token rotation, window reload/reopen, or a workspace change. Never paste a token into a public issue. |
| A workspace request is rejected | Discover the active workspace again. A configuration for a different window or stale workspace must not be reused blindly. |
| A file is denied | Check Workspace Trust, workspace-relative paths, sensitive names, symlinks, and read limits. |
| A write fails with a conflict | Re-read the current file and reconcile the content before writing. |
| A command does not execute | Enable terminal access locally and approve the individual command. A rejected or unattended approval does not authorize execution. |
| A remote connector fails | Check HTTPS forwarding, allowed hosts, preserved authorization headers, and the connector's authentication requirements. |

When reporting a problem, include the extension version, OS, VS Code version, client version, and a reproduction with dummy files. Remove secrets and private content. Use [private reporting](SECURITY.md) for vulnerabilities.

## License and acknowledgements

[MIT](LICENSE), with dependency licenses preserved in [third-party notices](THIRD_PARTY_NOTICES.md). See [acknowledgements](docs/ACKNOWLEDGEMENTS.md) for the upstream inspiration and protocol SDK. This project is a new implementation and does not imply endorsement by VS Code, upstream projects, or MCP client vendors.
