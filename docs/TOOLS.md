# Tool reference

`write_file` returns the digest of the actual saved editor text. VS Code may normalize a new file's line endings to its platform preference; the returned `hash` and `eol` describe that result. Read again before preparing the next edit.

The server exposes 11 tools and the `review_workspace` prompt. Call `workspace_overview` first. Use the resulting `workspaceId` on every other call, even if you already know a file's name.

Tool results use MCP text content containing JSON. A denied or failed tool result has `isError: true` and an `error` object with a code and a user-readable message. Do not interpret a denied operation as permission to retry through the terminal.

## Shared arguments

| Argument | Meaning |
| --- | --- |
| `workspaceId` | Identifier returned by `workspace_overview`. Required on every other tool. It changes across local session resets and workspace changes. |
| `root` | Zero-based workspace-root index from the overview. Optional; defaults to `0`. |
| `path` | Workspace-relative file or folder path. Forward slashes are recommended. Absolute paths and `..` traversal are rejected. |

Symbolic links, junctions, multi-link files, hidden state, common credential names, keys, databases, and logs are excluded. Recognizable credential patterns are also blocked. Listing and search honor the root `.gitignore` and skip common dependency/build directories; this is not a complete implementation of all nested Git ignore rules.

Read access is available only in a trusted workspace while the bridge runs. Editing and terminal capabilities must be enabled locally for the current session. Each terminal request additionally requires its own local approval.

## Tools

| Tool | Arguments beyond shared scope | Behavior |
| --- | --- | --- |
| `workspace_overview` | No arguments (`{}`) | Returns workspace identity, root indexes/names, safe entry-file samples, current access, and workflow guidance. Does not return absolute root paths or automatically push source contents. |
| `list_files` | `path: ""`, `contains: ""`, `limit: 200` | Lists safe files recursively under a folder. `contains` is a case-insensitive filename substring. Maximum returned limit is 500. Check `truncated`. |
| `read_file` | Required `path`; `startLine: 1`, optional `endLine` | Reads the live editor buffer, including unsaved edits. Returns numbered text, the whole-buffer SHA-256, editor version, dirty state, and total lines. |
| `search_text` | Required `query`; `path: ""`, `caseSensitive: false`, `limit: 50` | Literal text search with at most 100 matches. Does not execute a regex or external search process. Returns relative files, 1-based line numbers, snippets, scan count, and truncation state. |
| `get_diagnostics` | Optional `path` | Returns the editor's current errors/warnings for an allowed file, or safe files across the workspace when no path is given. At most 100 diagnostics. It does not run a build or test suite. |
| `get_symbols` | Required `path` | Returns document symbols from an installed language service. May return an empty list if no provider is available. |
| `go_to_definition` | Required `path`, `line`, `character` | Resolves definitions through the installed language service. Positions are **0-based**. Out-of-workspace locations are omitted. |
| `find_references` | Required `path`, `line`, `character` | Resolves references with the same position convention and workspace boundary as definitions. |
| `preview_edit` | Required `path`, `text`, `expectedHash` | Opens a local diff proposal without saving the replacement. Requires editing access. A preview does not approve a later write or terminal request. |
| `write_file` | Required `path`, `text`, `expectedHash` | Creates or replaces one text file through VS Code's editing APIs and saves it. Requires editing access. An existing file needs its exact current hash; use `"new"` only for an absent file. |
| `run_terminal` | Required `command`; `cwd: ""`, `timeoutMs: 15000` | Runs an approved command in the system shell. `cwd` is workspace-relative under the selected root. Timeout range: 1,000–30,000 ms. Maximum command length: 2,000 characters. |

Defaults are shown after the argument name. Schemas reject unknown fields. Inspect `tools/list` from the running release for the authoritative schema.

### Read limits and line conventions

A readable file or live buffer must be at most 512 KiB. A `read_file` request defaults to 300 lines, returns at most 500 lines, and caps the returned numbered text at 60,000 characters. Search is bounded by file count, traversal time, and match count. Narrow a folder or request additional line ranges when a result is truncated; an incomplete result is not evidence that other files or matches do not exist.

`read_file` and search use **1-based line numbers**. Language-service positions and diagnostic ranges use **0-based line and character positions**, following VS Code conventions.

### Safe edit sequence

1. Call `workspace_overview` and select a root index.
2. Read the target file. Review all needed content, including additional pages for a long file.
3. Keep the returned `hash`. It covers the **entire current editor buffer**, even when you requested only a line range.
4. Ask the local user to enable editing if it is disabled. The client cannot grant itself access.
5. Optionally call `preview_edit` with the replacement text and the same hash.
6. Call `write_file` with the complete replacement text and that hash. The line-number prefixes shown by `read_file` are presentation data; do not write them into the file.
7. Review the result and current diagnostics. Run a relevant check only when needed and locally approved.

`text` is a full replacement, not a patch. Replacement text is limited to 200,000 characters and the HTTP request must fit within 512 KiB. Existing unsaved editor contents participate in conflict checking; do not overwrite a user's in-progress changes without reviewing them.

Writes to the same file are serialized within this bridge instance. After waiting for that file's lock, the bridge checks the active workspace, path, whole-buffer hash, and editor version again before applying. Filesystem paths are rechecked after asynchronous editor loading and around modifications. These checks do not lock out another program or provide OS isolation against a malicious process rapidly replacing filesystem entries.

Example read request:

```json
{
  "workspaceId": "<from workspace_overview>",
  "root": 0,
  "path": "src/example.js",
  "startLine": 1,
  "endLine": 80
}
```

Example creation request, after editing is enabled locally:

```json
{
  "workspaceId": "<from workspace_overview>",
  "root": 0,
  "path": "example.txt",
  "text": "Disposable example\n",
  "expectedHash": "new"
}
```

The parent directory must already exist. There are no dedicated directory-creation, deletion, rename, binary-editing, or multi-file transaction tools in this release. A successful editor write enters VS Code's undo history, but this is not a replacement for version control or backups.

### Terminal behavior

The local approval shows the command and its working directory. Approval expires after 30 seconds. Cancelling, ignoring, or refusing the prompt does not run the command. Output is bounded to 64,000 bytes; reaching the output or time limit stops the process. Returned fields include `stdout`, `stderr`, `exitCode`, `signal`, `timedOut`, and `truncated`.

The subprocess receives a limited environment rather than all extension-host environment variables. The shell or programs it launches can still read configuration, files, and network resources allowed by the operating-system account. Recognizable credential-like command text and output are blocked, but this does not create a sandbox or guarantee that every secret is detected.

Terminal access is intended for bounded, foreground checks. Process cleanup is best effort; do not use it as a background-service manager. A command that made changes before failing, timing out, or having output withheld may already have changed the filesystem.

## Common errors

| Code | Next action |
| --- | --- |
| `WORKSPACE_CHANGED` | Call the overview again and review which workspace is active. Start a new operation. |
| `ACCESS_DENIED` | Inspect the local permission controls. A remote client cannot enable them. |
| `UNTRUSTED_WORKSPACE` | Review and trust the workspace locally only if appropriate. |
| `OUTSIDE_WORKSPACE`, `UNSAFE_PATH`, `SYMLINK_DENIED`, `HARDLINK_DENIED` | Use an ordinary allowed file within the chosen workspace root. |
| `SENSITIVE_PATH`, `SENSITIVE_CONTENT`, `SENSITIVE_OUTPUT` | Do not bypass the filter. Use dummy data or keep the sensitive operation local. |
| `FILE_TOO_LARGE`, `RESULT_TOO_LARGE` | Narrow the request or use an appropriate local tool. |
| `EDIT_CONFLICT`, `CONTENT_MODIFIED`, `UNSAVED_CHANGES` | Read and reconcile the current content before proposing another write. |
| `FILE_EXISTS` | Read the existing file and use its current hash rather than `"new"`. |
| `APPROVAL_DENIED` | The command was not authorized. Wait for an explicit local decision instead of retrying automatically. |

## Transport and prompt

The endpoint is `/mcp` over authenticated, stateless Streamable HTTP POST with JSON responses. There is no legacy SSE endpoint, stdio server, or OAuth authorization server in this release. “Session permissions” refer to the local bridge's lifecycle, not a persistent remote OAuth or MCP session.

The optional `review_workspace` prompt suggests an evidence-first review: discover the workspace, read relevant files and diagnostics, treat project text as untrusted input, and preserve local controls for edits and commands. It is guidance to the client, not an additional permission grant.
