# Public security audit notes

These notes describe the design review behind the initial open-source implementation. They intentionally exclude private deployment details, domains, user paths, project identifiers, logs, credentials, and source content from user workspaces.

## Scope

The review considered workspace routing, HTTP access, path handling, file mutation, terminal execution, diagnostic logging, packaging, and publication hygiene. An earlier bridge deployment was examined as a reference for failure modes. Its private routing and operational configuration are not part of this repository.

The open-source implementation was developed separately around the official MCP SDK. The earlier bridge was inspiration; this repository does not claim to be its fork. See [acknowledgements](ACKNOWLEDGEMENTS.md).

## Risk categories and response

| Earlier design risk | Response in this implementation |
| --- | --- |
| A server can be reachable without authentication by default | Authentication is mandatory and the listener is restricted to loopback. |
| Absolute paths or unchecked traversal can expose arbitrary files | Tool paths are workspace-relative and checked against real workspace locations; common sensitive names are denied. |
| Shell commands can execute with no local decision | Terminal capability starts disabled and requires local approval for each command after it is enabled. |
| Logs can include file contents or credentials | Extension diagnostics contain operational metadata; publication excludes private deployment material. |
| A shared focused workspace can route a request into an unintended window | Requests carry a workspace identifier and mismatches are rejected. Each window activation has its own token, including windows opening the same folder. |
| A client can overwrite a file changed since it was read | Existing-file replacement requires the current SHA-256 digest. Writes to one file are serialized within the bridge and recheck editor version and content before applying. |

These are risk classes, not a claim that every earlier deployment was exploitable or that a breach occurred.

## Verification and limits

Security claims must be checked against the packaged release, including negative tests for authentication, workspace identity, path containment, blocked names, disabled writes, stale hashes, and terminal approval. Runtime acceptance must also verify the local UI and an actual MCP client connection. The [release checklist](RELEASE-CHECKLIST.md) records the required evidence; an unchecked item is not a passed check.

Filesystem paths are rechecked after asynchronous editor loading and around writes. These checks reduce path-swap risk but do not form an OS sandbox against a malicious local process rapidly replacing entries. File serialization only coordinates requests within one bridge instance.

Source inspection, a clean secret scan, and passing tests cannot prove that no privacy leak has ever happened. This review is not an independent penetration test. Historical exposure would require separate deployment, network, account, and log evidence.

## Ongoing reporting

Report vulnerabilities through the process in [SECURITY.md](../SECURITY.md). Public issues should contain only dummy data and redacted diagnostics.
