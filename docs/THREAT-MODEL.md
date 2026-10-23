# Threat model

## Purpose and assets

The extension lets a selected MCP client access a workspace currently open in VS Code. Assets include file contents, credentials present in files or process environment, terminal privileges, file integrity, and the user's ability to choose which workspace receives a request.

The trusted computing base includes VS Code, its extension host, the operating system, the MCP SDK, the installed extension package, and any remote forwarding layer chosen by the user. A compromised operating-system account or extension host is outside the protection offered by this extension.

## Boundaries and controls

| Boundary | Main risk | Control | Remaining limitation |
| --- | --- | --- | --- |
| HTTP client → server | Unauthenticated control | Mandatory bearer authentication before MCP dispatch; window-specific, reload-scoped token in SecretStorage | A stolen current token authorizes that window's enabled tools until it is revoked or the window is reloaded. |
| Network → local endpoint | Accidental public exposure; browser-origin confusion | Loopback-only listener and host validation | A user-managed forwarder introduces a separate public boundary. |
| Client → workspace | A stale or misdirected request reaches the wrong window | An explicit workspace identifier on tool requests; mismatch rejected | A client may still misunderstand or intentionally choose a valid identifier. |
| Supplied path → filesystem | Absolute paths, traversal, or links escape the workspace | Workspace-root resolution, real-path containment, rejection of links/multi-link files, and path rechecks after editor loading and around writes | A malicious local process rapidly swapping filesystem entries is not contained by an OS sandbox. |
| Allowed read → private data | Credentials embedded in ordinary files | Sensitive-name and recognizable credential-pattern filtering, read limits, and Workspace Trust | Heuristic filtering does not detect every secret in otherwise allowed files. |
| Read → write | Client silently changes project files or races another request | Local session switch, per-file write serialization, and current-file SHA-256/editor-version checks before apply | Other programs are not locked out; a user can authorize a destructive replacement, and writes may trigger other tools. |
| Client → shell | Arbitrary actions under the user's account | Local session switch and explicit approval per command | An approved command has the user's filesystem and network permissions. |
| Session → later session | Old grants or credentials reach a different window | Reset permissions on stop/workspace change; independent window tokens and a fresh token after reload; delete the current secret entry on normal shutdown | Stop/start within one window activation reuses the token. Resetting permissions or credentials cannot revoke copied data. |
| Diagnostics → shared logs | Local paths, contents, or credentials become public | Metadata-only extension diagnostics and a redaction-first reporting process | Client, OS, proxy, and manually shared logs are controlled separately. |

## Expected threat scenarios

An unauthenticated client must fail before learning workspace contents. A valid client requesting a file outside the workspace, a blocked sensitive file, a different workspace identifier, or a write while editing is disabled must receive a denied result. A write based on stale file contents must fail without overwriting the new version. A terminal command must not execute until the local user approves that specific request.

Project text and tool output are untrusted input to an AI client. A README, comment, dependency, or terminal message can contain instructions intended to manipulate the client. The client must decide how to use the content; the extension's local switches and approval prompts remain independent of such instructions.

## Remote deployments

A remote client adds transport security, proxy configuration, authentication propagation, and logging responsibilities. TLS, a narrow host allowlist, and the bearer token are all required. The local server's bearer authentication is not a replacement for the remote service's access controls. See [remote access](REMOTE-ACCESS.md).

## Not a security guarantee

The extension does not sandbox terminal commands, classify every sensitive file, control what an AI provider retains, or establish that an earlier installation never leaked data. Passing tests demonstrates the tested behavior for the tested build and platform. Review [release evidence](RELEASE-CHECKLIST.md) before deciding whether the release meets your needs.
