Workspace Bridge MCP 0.2.0 makes everyday editing more precise and the setup easier to understand.

- **On-demand editor context:** inspect the active allowed file and selection positions; selected text is returned only when explicitly requested.
- **Hover information:** use the installed language service for bounded type/documentation text, with timeout and stale-document checks.
- **Precise edits:** apply non-overlapping UTF-16 ranges or one unique literal replacement. Both default to a native diff preview and retain current-hash, version and per-file concurrency checks.
- **Better onboarding:** copy a starter prompt from the sidebar. The bilingual READMEs now include original diagrams, real screenshots made with synthetic sample data, and a short installation path.

The server provides 15 tools. Bearer authentication, loopback binding, workspace-root checks, read-only startup and per-command local terminal approval remain in place. The source is MIT licensed; third-party notices are included. Related-project research is documented without importing upstream implementations or imagery.

Install the attached VSIX using **Extensions: Install from VSIX**, open a trusted folder and run **Workspace Bridge: Start Bridge**. Copy the connection configuration only into a trusted MCP client: it contains a secret token. Read the setup guide for connection-format and OAuth compatibility limits.

The checksum file applies to the attached package. See the workflow for this tag and docs/VALIDATION.md for the exact acceptance scope. No automatic public tunnel, telemetry or operating-system command sandbox is provided; approved terminal commands have user-level permissions.
