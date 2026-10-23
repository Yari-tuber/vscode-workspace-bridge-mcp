Workspace Bridge MCP connects an MCP client to one trusted VS Code window.

- An authenticated, loopback-only Streamable HTTP endpoint using the official MCP SDK.
- A native sidebar with English and Chinese controls for connection, session access, token rotation and metadata-only diagnostics.
- Eleven tools for project context, live editor reads, literal search, language services, diff previews, conflict-checked text edits and locally approved commands.
- Read-only defaults, workspace identities, sensitive-file filtering, bounded output and per-file write serialization.
- MIT-licensed source, third-party license notices, tests and reproducible VSIX packaging.

Install the attached VSIX with **Extensions: Install from VSIX**, open a trusted local folder, and run **Workspace Bridge: Start Bridge**. Copy the client configuration only into a trusted MCP client; it includes a secret token. A reload creates a new window token, so copy the configuration again.

Read SECURITY.md and docs/THREAT-MODEL.md before exposing the endpoint through a reverse proxy. There is no automatic public tunnel or OAuth service. Terminal access is disabled by default, requires local approval for every command and is not an operating-system sandbox. Secret detection is a precaution, not a guarantee that all private content can be identified.
