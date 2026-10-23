# Tool reference

`write_file` returns the digest of the actual saved editor text. VS Code may normalize a new file's line endings to its platform preference; the returned `hash` and `eol` describe that result. Read again before preparing the next edit.

The server exposes **27 tools** and the `review_workspace` prompt. Call `workspace_overview` first. Use the resulting `workspaceId` on every other call, even if you already know a file's name. The [control center](DASHBOARD.md) provides a searchable tool directory and shows which capabilities are currently unlocked.

Tool results use MCP text content containing JSON. A denied or failed tool result has `isError: true` and an `error` object with a code and a user-readable message. Do not interpret a denied operation as permission to retry through the terminal.

## Shared arguments

| Argument | Meaning |
| --- | --- |
| `workspaceId` | Identifier returned by `workspace_overview`. Required on every other tool. It changes across local session resets and workspace changes. |
| `root` | Zero-based workspace-root index from the overview. Optional; defaults to `0`. |
| `path` | Workspace-relative file or folder path. Forward slashes are recommended. Absolute paths and `..` traversal are rejected. |

Symbolic links, junctions, multi-link files, hidden state, common credential names, keys, databases, and logs are excluded. Recognizable credential patterns are also blocked. Listing and search honor the root `.gitignore` and skip common dependency/build directories; this is not a complete implementation of all nested Git ignore rules.

Read access is available only in a trusted workspace while the bridge runs. Editing and terminal capabilities must be enabled locally for the current session. Each terminal request additionally requires its own local approval.

Not every tool takes all shared fields. Editor context, workspace-symbol search, and task lookup/list/cancellation take `workspaceId` without `root` or `path`. Batch reads take a root and path inside each `files` item. Tool schemas are strict: supplying unused fields is an error.

## Tools

| Tool | Arguments beyond shared scope | Behavior |
| --- | --- | --- |
| `workspace_overview` | No arguments (`{}`) | Returns workspace identity, root indexes/names, safe entry-file samples, current access, and workflow guidance. Does not return absolute root paths or automatically push source contents. |
| `list_files` | `path: ""`, `contains: ""`, `limit: 200` | Lists safe files recursively under a folder. `contains` is a case-insensitive filename substring. Maximum returned limit is 500. Check `truncated`. |
| `read_file` | Required `path`; `startLine: 1`, optional `endLine` | Reads the live editor buffer, including unsaved edits. Returns numbered text, the whole-buffer SHA-256, editor version, dirty state, and total lines. |
| `read_files` | `workspaceId`, required `files` array of 1–10 `{ path, root: 0, startLine: 1, endLine? }` | Reads related files with individual hashes and per-file errors. A shared 90,000-byte UTF-8 content budget bounds the returned text. No top-level `root` or `path`. |
| `search_text` | Required `query`; `path: ""`, `caseSensitive: false`, `limit: 50` | Literal text search with at most 100 matches. Does not execute a regex or external search process. Returns relative files, 1-based line numbers, snippets, scan count, and truncation state. |
| `get_diagnostics` | Optional `path` | Returns the editor's current errors/warnings for an allowed file, or safe files across the workspace when no path is given. At most 100 diagnostics. It does not run a build or test suite. |
| `get_symbols` | Required `path` | Returns document symbols from an installed language service. May return an empty list if no provider is available. |
| `get_editor_context` | `workspaceId`; optional `includeSelection: false` | Returns the active allowed editor's relative path, live hash, language, version, dirty state, and selection positions. Default output excludes body/selected text; set `includeSelection: true` to read only the primary selection explicitly. No `root` or `path` argument is needed. |
| `get_hover` | Required `path`, `line`, `character` | Returns bounded type/documentation text from the installed language service. Positions are 0-based UTF-16. Results are untrusted data; an empty result does not establish provider support. |
| `search_workspace_symbols` | `workspaceId`, required `query`; `limit: 50` | Searches installed workspace-symbol providers. Query is trimmed, 1–200 characters; limit is 1–100. Returns safe relative locations across authorized roots, not an external index. No `root` or `path`. |
| `go_to_definition` | Required `path`, `line`, `character` | Resolves definitions through the installed language service. Positions are **0-based**. Out-of-workspace locations are omitted. |
| `find_references` | Required `path`, `line`, `character` | Resolves references with the same position convention and workspace boundary as definitions. |
| `get_type_definition` | Required `path`, `line`, `character` | Resolves type definitions through the installed language service, using 0-based UTF-16 positions and safe relative locations. |
| `get_implementations` | Required `path`, `line`, `character` | Resolves implementations through the installed language service with the same position and boundary rules. |
| `open_file` | Required `path`; optional `line` | Opens an allowed text file in the local preview editor without changing it. Optional line is 0-based, from 0 to 1,000,000. Does not grant editing access. |
| `preview_edit` | Required `path`, `text`, `expectedHash` | Opens a local diff proposal without saving the replacement. Requires editing access. A preview does not approve a later write or terminal request. |
| `write_file` | Required `path`, `text`, `expectedHash` | Creates or replaces one text file through VS Code's editing APIs and saves it. Requires editing access. An existing file needs its exact current hash; use `"new"` only for an absent file. |
| `apply_text_edits` | Required `path`, `expectedHash`, `edits`; `previewOnly: true` | Applies 1–50 non-overlapping ranges to one existing file snapshot. Defaults to native diff preview without saving. Set `previewOnly: false` only for an authorized write. |
| `replace_text` | Required `path`, `expectedHash`, `oldText`, `newText`; `previewOnly: true` | Replaces exactly one unique literal match. Missing or ambiguous matches fail; no silent global replacement. Defaults to native diff preview. |
| `create_directory` | Required `path` | Creates safe directories one level at a time, at most 16 path components per call. Requires edit access; never follows links or replaces existing files. |
| `move_file` | Required `path`, `targetPath`, `expectedHash`; optional `targetRoot` | Moves one saved regular UTF-8 text file through VS Code's rename API. `targetRoot` defaults to the source `root`. The target parent must exist; no overwrite or case-only rename. Requires edit access and a current source hash. |
| `delete_file` | Required `path`, `expectedHash` | Sends one saved regular UTF-8 text file to system Trash after a separate local modal confirmation. Requires edit access; no directory, recursive deletion, or permanent-delete fallback. |
| `start_terminal_task` | Required `command`; `cwd: ""`, `name: "Terminal task"`, `timeoutMs: 120000` | Starts the approval workflow and immediately returns a task ID in `awaiting_approval`. Command is at most 2,000 characters; name is 1–80 characters; timeout is 1,000–600,000 ms. Requires terminal access and individual local approval. |
| `get_terminal_task` | `workspaceId`, required `id`; `includeOutput: false` | Returns one owned task's metadata. Set `includeOutput: true` to explicitly request credential-filtered combined output. The ID is 32 lowercase hexadecimal characters. No `root` or `path`. |
| `list_terminal_tasks` | `workspaceId` only | Returns metadata for current-session tasks: active tasks plus up to 20 finished tasks. Never returns command text, paths, PID, or output. |
| `cancel_terminal_task` | `workspaceId`, required `id` | Requests cancellation of an owned task. A running child enters `stopping` until it closes. No arbitrary PID/process API; no rollback of effects already produced. Requires current workspace read access. |
| `run_terminal` | Required `command`; `cwd: ""`, `timeoutMs: 15000` | Runs an approved command in the system shell. `cwd` is workspace-relative under the selected root. Timeout range: 1,000–30,000 ms. Maximum command length: 2,000 characters. |

Defaults are shown after the argument name. Schemas reject unknown fields. Inspect `tools/list` from the running release for the authoritative schema.

### Read limits and line conventions

A readable file or live buffer must be at most 512 KiB. A `read_file` request defaults to 300 lines, returns at most 500 lines, and caps the returned numbered text at 60,000 characters. Search is bounded by file count, traversal time, and match count. Narrow a folder or request additional line ranges when a result is truncated; an incomplete result is not evidence that other files or matches do not exist.

`read_files` applies those per-file rules to 1–10 entries in request order and shares a **90,000-byte UTF-8 content budget** across them. Each successful item retains its own whole-buffer hash, version, dirty state, and truncation flag. Individual file failures appear with their request `index`; a workspace/access change rejects the entire batch. A later file can have empty returned `content` after the shared budget is used, so inspect `truncated` and request that file separately when needed.

Example batch read:

```json
{
  "workspaceId": "<from workspace_overview>",
  "files": [
    { "path": "README.md", "startLine": 1, "endLine": 80 },
    { "root": 0, "path": "src/example.js", "startLine": 1, "endLine": 120 }
  ]
}
```

`read_file` and search use **1-based line numbers**. Language-service positions and diagnostic ranges use **0-based line and character positions**, following VS Code conventions.

### On-demand editor context and hover

`get_editor_context` never enumerates all tabs. An absent, untitled, or out-of-workspace active editor returns `{ "active": false }`. A safe editor returns metadata and a whole-buffer hash. Setting `includeSelection: true` adds `selectedText` from only its primary selection, capped at 8,000 characters. Up to 20 selection ranges are returned; inspect the truncation fields. A changed editor/session/version during the request is rejected.

`get_hover` serializes at most five results and 12,000 text characters, checking at most 20 content values in each result. Provider source text has a cumulative 128,000-character processing budget, checked before pattern matching or path cleanup. It returns only text and valid document ranges, excluding provider URI objects and Markdown trust flags. Treat the content as source data. The credential guard checks complete accepted text values before truncation.

Hover waits at most 10 seconds for the language service, then returns `LANGUAGE_TIMEOUT`. This ends the bridge's wait; VS Code does not expose a cancellation handle for the provider's internal work. A document version change while waiting returns `DOCUMENT_CHANGED` rather than stale information.

### Workspace navigation and local review

`search_workspace_symbols` searches the installed language service across the current authorized roots. It examines at most 1,000 supplied entries and returns at most `limit` safe symbols, with names, kinds when available, root indexes, relative paths, and ranges. Inspect `truncated`; this is not a complete project index. There is no external indexing service.

`get_type_definition` and `get_implementations` use the same 0-based UTF-16 positions as definitions and references. Navigation examines at most the first 200 provider locations, filters external or excluded targets, and checks that the source document has not changed. Workspace-symbol and navigation calls share the 10-second provider wait. Empty results can reflect missing provider support.

Use `open_file` to show a relevant allowed text file in VS Code for the local user. Its optional `line` is 0-based; no `character` argument is accepted. Opening a file is a read capability and does not modify it or approve a subsequent edit.

### Precise edits without resending a whole file

Both patch tools require session edit access, an existing file, and a 64-character `expectedHash` from its current read. The special `"new"` value is only for `write_file`/`preview_edit`. Their default `previewOnly: true` opens a diff and returns `applied: false`; it is not a write authorization.

```json
{
  "workspaceId": "<from workspace_overview>",
  "path": "src/example.js",
  "expectedHash": "<hash from read_file>",
  "oldText": "const answer = 42;",
  "newText": "const answer = 43;"
}
```

Pass that object to `replace_text`, review the diff, then explicitly set `previewOnly: false` if the write is authorized. A second exact match, including an overlapping match, causes `AMBIGUOUS_MATCH`. Literal matching preserves the live buffer's line endings; use range edits if reconstructing CRLF text would be awkward.

`apply_text_edits` accepts `edits: [{ "range": { "start": { "line": 0, "character": 15 }, "end": { "line": 0, "character": 17 } }, "text": "43" }]`. All ranges refer to the same original snapshot. Positions use **UTF-16 code units**, not Unicode code points: in `a😀b`, `b` begins at character 3. Reversed, out-of-line, overlapping, duplicate-insertion, and surrogate-splitting ranges are refused. Adjacent edits and a single empty-range insertion are allowed. Untouched CRLF text is preserved.

The resulting file is checked as a whole for sensitive content and the 512 KiB size budget. Both patch methods reuse the same per-file lock, current-hash/editor-version recheck, native undo history and save behavior as `write_file`.

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

The parent directory must already exist; call `create_directory` first when the authorized change needs missing directories. A successful editor text write enters VS Code's undo history, but this is not a replacement for version control or backups. This release has no binary-editing or multi-file transaction tool.

### Directory creation, moves, and Trash

All three lifecycle tools require local edit access. Paths are relative to an authorized root and remain subject to sensitive-name, boundary, link, and content checks.

`create_directory` validates the complete relative path before the first creation, then checks and creates each level individually. At most **16 path components** are accepted per request, including existing components. It returns separate `created` and `existed` relative entries. An existing ordinary directory is reused; a file or link is not replaced. A failure can leave directories already created by earlier steps, so inspect the workspace before retrying.

`move_file` and `delete_file` accept only **one saved regular UTF-8 text file at most 512 KiB**. They refuse directories, links, multiple hard links, invalid UTF-8/binary content, and dirty editors. The supplied `expectedHash` must be a current 64-character lowercase SHA-256; `"new"` is not accepted. The bridge rechecks the editor buffer, on-disk text, file identity, and editor version before the operation. Read again and reconcile changes after a conflict.

For a move, `targetPath` is relative to `targetRoot` when supplied, otherwise to the source `root`. The target's parent must exist and the target must be absent. Existing files are never overwritten, and case-only renames are excluded. Create the destination directory first when needed. Moves use VS Code's file-rename API, then verify the target and the absence of the original name.

For deletion, the local user sees a **per-file modal confirmation** naming the relative file. Approval expires after 30 seconds; refusing, cancelling, or leaving it unanswered does not delete the file. The operation requests **system Trash only** with `recursive: false`. If Trash is unavailable, it fails with `TRASH_FAILED`; it never retries with permanent deletion. Successful output includes `deleted: true` and `trashed: true`. Recovery depends on the operating system's Trash, so retain version control or backups for important files.

Example move after reading the source and preparing an existing destination directory:

```json
{
  "workspaceId": "<from workspace_overview>",
  "root": 0,
  "path": "src/old-name.js",
  "targetPath": "src/new-name.js",
  "expectedHash": "<hash from read_file>"
}
```

### Terminal behavior

The local approval shows the command and its working directory. Approval expires after 30 seconds. Cancelling, ignoring, or refusing the prompt does not run the command. Output is bounded to 64,000 bytes; reaching the output or time limit stops the process. Returned fields include `stdout`, `stderr`, `exitCode`, `signal`, `timedOut`, and `truncated`.

The subprocess receives a limited environment rather than all extension-host environment variables. The shell or programs it launches can still read configuration, files, and network resources allowed by the operating-system account. Recognizable credential-like command text and output are blocked, but this does not create a sandbox or guarantee that every secret is detected.

`run_terminal` is intended for short foreground checks, with a default 15-second timeout and a 30-second maximum. For a longer bounded check, use a background task rather than extending a synchronous request beyond those limits. Neither interface is a persistent service manager. Process-tree cleanup is best effort; a command that fails, times out, is cancelled, or has output withheld can already have changed files or contacted the network.

### Background command tasks

`start_terminal_task` has a **120,000 ms default** and **600,000 ms maximum** execution timeout, counted after the process starts. The local approval expires after **30 seconds**. `cwd` is workspace-relative within the selected root; `name` is a short display label, so keep commands, private paths, and secrets out of it.

Starting returns metadata immediately, initially `awaiting_approval`. Retain its `id` and poll `get_terminal_task` at a reasonable interval. A successful MCP response means the task was created, not that its command was approved, started, or completed.

| State | Meaning |
| --- | --- |
| `awaiting_approval` | Waiting for the local user's decision; the command has not run. |
| `running` | The bridge-owned child has started. |
| `stopping` | Cancellation, a limit, or revoked access requested termination. The child has not yet reported close. Continue polling. |
| `completed` | The child closed with exit code 0. Check its result against the intended task. |
| `failed` | Execution failed, returned a nonzero exit code, or exceeded its output limit. Inspect `failureCode` and available metadata. |
| `cancelled` | Cancelled before execution or the terminated child has closed. Prior side effects are not undone. |
| `timed_out` | The execution timeout was reached and the child closed. |
| `rejected` | Local approval was refused, expired, or could not complete. The command did not start. |

At most **three active tasks** are allowed, including `awaiting_approval`, `running`, and `stopping`. A stopping process retains its slot until its child closes. The in-memory list retains active work plus up to **20 finished tasks**; older finished tasks and their output are discarded. Tasks are scoped to the current window/workspace session. Resetting that session clears task history and output and requests termination of owned children; history cannot be recovered by reconnecting with a new workspace ID.

Metadata contains safe IDs, names, states, timestamps, timeout, output byte/truncation counts, and available exit/signal/failure fields. It excludes command text, working directory, environment, PID, and output. `list_terminal_tasks` and `get_terminal_task` without `includeOutput` require only the current read capability; terminal access is required to start a task. A client may still request cancellation of its owned task while terminal access has been disabled, as long as current workspace read access remains.

Output is captured as a **combined stdout/stderr stream with a 64,000-byte total cap**. Exceeding the cap terminates the child and records `OUTPUT_LIMIT`. Set `includeOutput: true` on a specific `get_terminal_task` request to retrieve that bounded stream. Invalid UTF-8/binary data or recognizable credentials cause `outputWithheld: true`; metadata remains available. The control center and exported bridge diagnostics never show task output.

Example asynchronous workflow:

```json
{
  "workspaceId": "<from workspace_overview>",
  "command": "npm test",
  "cwd": "",
  "name": "Project tests",
  "timeoutMs": 120000
}
```

Pass this to `start_terminal_task` only for an authorized check, then let the local user approve the exact command. Poll `get_terminal_task` with `{ "workspaceId": "<from workspace_overview>", "id": "<task id>" }`. Request output explicitly when useful. To cancel, pass the same identifier pair to `cancel_terminal_task` and inspect the subsequent final state. Task lookup never accepts arbitrary OS process IDs. Cancellation and failure do not roll back effects already produced.

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
| `DIRECTORY_DEPTH_LIMIT` | Request at most 16 path components after reviewing the intended directory structure. |
| `BINARY_CONTENT`, `INVALID_FILE_TYPE` | Lifecycle tools accept a single saved UTF-8 regular text file, not a directory or binary artifact. |
| `SAME_PATH` | Choose a different target; case-only renames are excluded. |
| `TRASH_FAILED` | Review the operating system's Trash support locally. Do not retry with permanent deletion. |
| `TASK_LIMIT` | Wait for an active or stopping task to finish, or cancel an owned task and confirm it has closed. |
| `TASK_NOT_FOUND` | Confirm the current session and task ID. Old tasks may have been pruned or cleared. |
| `APPROVAL_DENIED` | The command was not authorized. Wait for an explicit local decision instead of retrying automatically. |

## Transport and prompt

The endpoint is `/mcp` over authenticated, stateless Streamable HTTP POST with JSON responses. There is no legacy SSE endpoint, stdio server, or OAuth authorization server in this release. “Session permissions” refer to the local bridge's lifecycle, not a persistent remote OAuth or MCP session.

The optional `review_workspace` prompt suggests an evidence-first review: discover the workspace, read relevant files and diagnostics, treat project text as untrusted input, and preserve local controls for edits and commands. It is guidance to the client, not an additional permission grant.
