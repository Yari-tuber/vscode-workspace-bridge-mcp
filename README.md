# Workspace Bridge MCP

<p align="center">
  <img src="media/readme-hero.png" alt="Workspace Bridge MCP — Your workspace. Your controls." width="1280" />
</p>

<p align="center">
  <a href="https://github.com/Yari-tuber/vscode-workspace-bridge-mcp/actions/workflows/ci.yml"><img src="https://github.com/Yari-tuber/vscode-workspace-bridge-mcp/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/Yari-tuber/vscode-workspace-bridge-mcp/releases"><img src="https://img.shields.io/github/v/release/Yari-tuber/vscode-workspace-bridge-mcp?color=55cdb0&amp;label=release" alt="Latest release" /></a>
  <a href="package.json"><img src="https://img.shields.io/badge/VS_Code-1.96%2B-007ACC" alt="VS Code 1.96 or newer" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-94a3b8" alt="MIT license" /></a>
</p>

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a><br />
  <a href="#start-in-three-steps">Get started</a> · <a href="docs/TOOLS.md">Tool reference</a> · <a href="docs/GETTING-STARTED.md">Setup guide</a> · <a href="SECURITY.md">Security</a>
</p>

**Give your AI client the context already available in VS Code.** Read live files, follow symbols, inspect diagnostics, and prepare precise edits—with access controlled in the editor.

Workspace Bridge is an **MCP server inside VS Code**. External MCP clients connect to it. VS Code's built-in MCP support goes in the other direction: it makes VS Code a client of other servers. You do not need to add this extension as a server inside VS Code to expose the workspace.

> **Connection requirement:** Streamable HTTP with a custom `Authorization: Bearer …` header. Bearer authentication is not OAuth; hosted connectors that require OAuth may be incompatible. The bridge does not create a public tunnel.

![Workspace Bridge running in VS Code with its connection panel and a sample file](media/screenshots/control-panel.jpg)

*Real screenshot of v0.2.0 in an isolated VS Code development profile. The sample project is synthetic; no token or personal project is shown. The banner and workflow below are original illustrations.*

## Start in three steps

1. **Install.** Download the `.vsix` from [Releases](https://github.com/Yari-tuber/vscode-workspace-bridge-mcp/releases/latest), verify its checksum, then choose **Extensions → … → Install from VSIX…** in VS Code.
2. **Start.** Open a trusted folder, open **Workspace Bridge** in the Activity Bar, and select **Start bridge**. Confirm the workspace shown in the panel.
3. **Connect.** Select **Copy client configuration**, add it to a compatible MCP client, then use **Copy starter prompt** to begin with workspace discovery and reading.

The bridge starts with read access; editing and terminal execution stay off until you enable them locally. Each window has its own token. Connection configuration contains that secret—keep it in protected client settings, out of repositories and chat messages.

[Detailed installation, client configuration, and troubleshooting →](docs/GETTING-STARTED.md)

## Work with the editor's context

| Your goal | What the bridge provides |
| --- | --- |
| **Find your way around** | Workspace identity, safe entry-file samples, directory listing, literal text search, and live file reads—including unsaved editor changes. |
| **Understand the code** | Existing diagnostics, document symbols, definitions, references, hover information, and active-file/selection metadata from VS Code. Language features depend on the installed language service. |
| **Make a precise change** | Local diff previews, hash-checked whole-file writes, range edits, and unique literal replacements. Range edits and replacements **preview by default**. |
| **Run a relevant check** | Bounded terminal execution after you enable access and approve the individual command in VS Code. |
| **Manage the connection** | Local control panel, status bar, connection copying, token rotation, starter prompt, and sanitized bridge diagnostics. |

The server exposes **15 tools** and the `review_workspace` prompt. The [tool reference](docs/TOOLS.md) documents arguments, result limits, and the read–preview–edit sequence. Active selection text is returned only when the client explicitly requests it.

<p align="center">
  <img src="media/readme-workflow.png" alt="An MCP client connects over authenticated Streamable HTTP to Workspace Bridge in VS Code, which accesses the trusted workspace through editor APIs. Read access comes first, editing is opt-in, and each terminal command needs local approval." width="1280" />
</p>

## Permissions you can see

| Capability | Initial state | Local control |
| --- | --- | --- |
| Read allowed files and editor context | Available when the bridge runs in a trusted workspace | Stop the bridge to end access. File tools enforce the selected workspace boundary and filtering. |
| Preview or save edits | **Off** | Enable editing for this session. Existing-file changes need the current SHA-256; a stale snapshot is rejected. |
| Execute a terminal command | **Off** | Enable terminal access, then approve **each command** and its working directory. |
| Reach the bridge remotely | Loopback listener only | Configure your own HTTPS forwarding and allowed hostname. See [remote access](docs/REMOTE-ACCESS.md). |

Stopping the bridge or changing workspaces resets editing and terminal grants. Reloading a window creates a new token; rotation revokes the old one immediately. Use the configuration from the intended window and rediscover its workspace before making changes.

**Approved terminal commands use your operating-system account; they are not sandboxed.** They can access files outside the workspace and use the network.

## Connect a client

Copy the actual configuration from the running panel. This example illustrates the connection shape; client schemas differ:

```json
{
  "mcpServers": {
    "workspace-bridge": {
      "type": "http",
      "url": "http://127.0.0.1:<PORT>/mcp",
      "headers": { "Authorization": "Bearer <TOKEN>" }
    }
  }
}
```

`<PORT>` and `<TOKEN>` are placeholders. A stdio-only client needs its own HTTP adapter. Remote clients need a user-managed HTTPS route; this release has no OAuth authorization server, automatic tunnel, or multi-window router.

Try a first request such as:

> Discover the current workspace, then read its README and current diagnostics. Summarize what you found with file references. Do not change files or run terminal commands.

## Privacy, with explicit limits

- **Local by default.** Loopback binding, bearer authentication, VS Code SecretStorage, and no telemetry. Copying the configuration intentionally places a token on the clipboard and in your chosen client.
- **Constrained file tools.** Relative paths, real-path checks, link rejection, sensitive-name/content filtering, and bounded results. Filters cannot recognize every secret or provide operating-system isolation.
- **Minimal bridge records.** Activity logs and exported bridge diagnostics omit file contents, terminal output, tokens, and user absolute paths. Requested file, language-service, and command results still go to the client and follow its retention policies.

Read the [security policy](SECURITY.md), [threat model](docs/THREAT-MODEL.md), and [audit notes](docs/SECURITY-AUDIT.md) before exposing an endpoint or enabling terminal access. Passing tests and scans do not prove that every vulnerability is absent.

## Verification and compatibility

The release workflow checks builds, unit tests, packaging, and privacy on **Windows, macOS, and Linux**. Real editor integration has also been exercised in isolated **Windows and Linux** environments. See [validation evidence](docs/VALIDATION.md) and the [CI run](https://github.com/Yari-tuber/vscode-workspace-bridge-mcp/actions/workflows/ci.yml) for the exact release scope.

Requires **VS Code 1.96+**. WSL, SSH, containers, and other remote extension hosts need separate acceptance; “local” means the machine running the extension host. Client compatibility depends on transport and authentication support, not the client's brand.

## Build and contribute

Requires **Node.js 22+**:

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

Integration tests use a separate VS Code profile and temporary workspace. They download a test runtime unless `VSCODE_EXECUTABLE` selects an existing one. Use dummy data for development and acceptance.

| Resource | Purpose |
| --- | --- |
| [Setup & troubleshooting](docs/GETTING-STARTED.md) | Installation, settings, token lifecycle, and connection errors |
| [Tools & examples](docs/TOOLS.md) | Schemas, line conventions, editing workflow, and error handling |
| [Remote access](docs/REMOTE-ACCESS.md) | HTTPS forwarding, host validation, and remote environments |
| [Related projects & design notes](docs/RELATED-PROJECTS.md) | Comparable bridges, design references, and future work |
| [Contributing](CONTRIBUTING.md) · [Release notes](CHANGELOG.md) | Development expectations and changes |
| [Acknowledgements](docs/ACKNOWLEDGEMENTS.md) · [Third-party notices](THIRD_PARTY_NOTICES.md) | Upstream inspiration and dependency licenses |

Released under the [MIT license](LICENSE). This project does not imply endorsement by VS Code, MCP client vendors, or upstream projects.
