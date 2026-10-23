Workspace Bridge MCP 0.3.0 expands the editor bridge from 15 to 27 tools and adds a full control center.

- **Work across files:** batch reads, workspace symbol search, type definitions, implementation navigation and local file review.
- **Organize a project:** create safe directories, move saved UTF-8 files without overwriting, and send individual files to system Trash only after local confirmation and hash checks.
- **Follow long checks:** start locally approved command tasks, query status and filtered output, or cancel bridge-owned tasks. Stopping processes keep their concurrency slots until they actually close.
- **See the controls:** a bilingual, theme-aware panel for connection, permissions, searchable tools, task states and metadata-only activity. Native sidebar controls remain available.

The server still starts read-only, binds loopback, requires a bearer token and preserves workspace/path checks. Command tasks use full user privileges after approval, not an OS sandbox. Filesystem, network or other side effects already produced by a command are not undone by cancellation. Trash never falls back to permanent deletion.

Install the attached VSIX with Extensions: Install from VSIX, open a trusted folder, then run Workspace Bridge: Open Control Center. Use the setup guide to connect a compatible Streamable HTTP client. Copied client configuration contains a secret token; keep it private. No automatic public tunnel or OAuth service is included.

See docs/VALIDATION.md and the workflow for this release commit for the exact test scope. Verify the attached package against SHA256SUMS.txt before installing.
