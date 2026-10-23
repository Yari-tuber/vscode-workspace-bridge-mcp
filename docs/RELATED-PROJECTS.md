# Related projects and design notes

[English README](../README.md) · [中文说明](../README.zh-CN.md)

Reviewed on **2026-10-23**. This is a comparison of public READMEs, selected source files, and repository licenses. It is not a security audit of these projects, a feature benchmark, or an endorsement. Features and repository status can change.

中文概要：GitHub 上已有多种让外部 AI 操作 VS Code 的 MCP 扩展。最值得借鉴的是语言服务导航、原生 Diff 和清晰的连接指引。Workspace Bridge 的改进继续保留本地开启、工作区校验、敏感信息拦截和终端逐条批准的边界。

## Directly related projects

| Project | Relevant approach | What it informs here | License |
| --- | --- | --- | --- |
| [juehang/vscode-mcp-server](https://github.com/juehang/vscode-mcp-server) | Language-service symbol search, document outlines, hover information, and configurable tool categories. | Let an agent locate a symbol and understand its type before reading whole files. Bound results and avoid duplicating tools the client already has. Its README explicitly says authentication is not implemented, so its local-only assumptions should not be carried into a remote deployment. | [MIT](https://github.com/juehang/vscode-mcp-server/blob/master/LICENSE) |
| [jhamama/vscode-mcp-bridge](https://github.com/jhamama/vscode-mcp-bridge) | Native diff previews, live language-service diagnostics, file tools, and managed terminals. | Keep edits visible in the editor and check diagnostics after a change. Automatic context push and persistent terminals deserve separate permission and disclosure decisions. | [MIT](https://github.com/jhamama/vscode-mcp-bridge/blob/main/LICENSE) |
| [Danchuna/vscode-mcp-api](https://github.com/Danchuna/vscode-mcp-api) | A derivative of `jhamama/vscode-mcp-bridge` with a connection panel, copyable starter instructions, and tunnel integration. | Make setup and troubleshooting discoverable in the panel. A public URL increases exposure; optional authentication and default context push from that design are not suitable defaults for this bridge. | [MIT](https://github.com/Danchuna/vscode-mcp-api/blob/main/LICENSE) |
| [nabheet/vscode-mcp-server](https://github.com/nabheet/vscode-mcp-server) | Workspace symbols, hover, batch file reads, debugger tools, and multi-window routing. | Prefer explicit workspace identity and structured, bounded language-service results. Batch reads and multi-window discovery are useful future work, but need their own filtering and routing tests. | [MIT](https://github.com/nabheet/vscode-mcp-server/blob/main/LICENSE) |
| [block/vscode-mcp](https://github.com/block/vscode-mcp) | Separate server/extension architecture, native diff review with accept/reject interaction, and project discovery. | A proposed change should be understandable before it is applied. The repository was archived on 2025-11-04; treat it as an interaction reference rather than an actively maintained dependency. | [Apache-2.0](https://github.com/block/vscode-mcp/blob/main/LICENSE) |

## Improvements selected for this release

### 1. Explain the symbol under the cursor

`get_hover` supplies the installed language provider's type information and documentation for an explicit file and position. It complements existing document symbols, definitions, references, and diagnostics, without requiring the agent to read whole files to identify a function signature.

The implementation uses VS Code's language provider API, retains workspace and sensitive-content checks, bounds the response, and treats provider text as untrusted data. It does not add an external indexing service.

Related implementations: [juehang symbol tools](https://github.com/juehang/vscode-mcp-server/blob/master/src/tools/symbol-tools.ts), [nabheet LSP tools](https://github.com/nabheet/vscode-mcp-server/blob/main/src/mcp/tools/lsp.ts), and [jhamama VS Code bridge](https://github.com/jhamama/vscode-mcp-bridge/blob/main/src/bridge/VsCodeBridge.ts). The implementation here is independently written against the [official built-in command API](https://code.visualstudio.com/api/references/commands#vscode.executeHoverProvider).

### 2. Understand “this file” and “this selection” on demand

`get_editor_context` lets an agent request the current editor and selection in the authorized workspace. This improves everyday prompts such as “explain this selection.” It follows the useful live-editor interaction in [jhamama's context snapshots](https://github.com/jhamama/vscode-mcp-bridge/blob/main/src/bridge/VsCodeBridge.ts), while keeping the request explicit and applying this bridge's path and content checks. It does not enable automatic context push.

### 3. Make small changes precise and reviewable

`replace_text` supports a unique literal replacement; `apply_text_edits` supports explicit text ranges. Both preserve the read-before-write hash check and the existing editor mutation path. A small change should not require an agent to reconstruct an entire file, and an ambiguous match should not silently change several locations.

The interaction is informed by [juehang's line-edit tools](https://github.com/juehang/vscode-mcp-server/blob/master/src/tools/edit-tools.ts) and native diff workflows in [Block's diff manager](https://github.com/block/vscode-mcp/blob/main/extension/src/diffManager.ts). Workspace Bridge's range validation and expected-hash handling are independently implemented. Existing `preview_edit` remains available to show the resulting file before applying a change.

Positions follow VS Code's convention: zero-based line and character values, with character offsets measured in UTF-16 code units. See the [official Position declaration](https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.d.ts#L269-L286) and [TextDocument offset APIs](https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.d.ts#L199-L213). This matters for characters outside the Basic Multilingual Plane, such as emoji.

### 4. A clear first successful connection

Show server status, endpoint, current access, and next steps together. A starter prompt can explain the safe workflow: discover the workspace, read relevant files, use the latest hash for edits, and check diagnostics. It must never include a bearer token or local absolute path.

The copy-and-connect interaction is informed by [Danchuna's panel source](https://github.com/Danchuna/vscode-mcp-api/blob/main/src/extension.ts). The new starter prompt explains the selected workflow. Tunnel creation is a separate capability and is not required to improve the local setup flow.

## Further work

- **Workspace symbol search:** useful for finding a function across a project; requires careful filtering of every provider location and bounded results across roots. See [juehang's implementation](https://github.com/juehang/vscode-mcp-server/blob/master/src/tools/symbol-tools.ts).
- **Batch reads:** useful when several related files are already known; needs per-file errors and a shared response budget. See [nabheet's workspace tools](https://github.com/nabheet/vscode-mcp-server/blob/main/src/mcp/tools/workspace.ts).
- **Multi-window discovery:** requires explicit window identity and tests for reload, disconnect, and routing changes. It must not silently route a request to a different project.

These are future design topics, not claims of features included in this release.

## Boundaries retained

- No automatic public tunnel or account-wide credential distribution.
- No automatic push of active files, selections, or editor state to clients.
- No arbitrary VS Code command executor or debugger evaluation added merely to increase the tool count.
- No relaxation of workspace, path, secret-content, edit-conflict, or terminal-approval checks.

These are design decisions for this project, not claims that another project is unsafe in every deployment. A local trusted client and an internet-facing service have different exposure.

## Attribution and implementation policy

This document credits related work and links to primary sources. It does not import their code, icons, screenshots, or README text. New tools should be implemented against documented VS Code APIs and covered by this project's security and editor-host tests.

If source is reused later, record the exact files and revision, retain the upstream copyright and license notices, and update [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md). MIT and Apache-2.0 are not permission to omit attribution or required notices. Screenshots and branding require their own review.
