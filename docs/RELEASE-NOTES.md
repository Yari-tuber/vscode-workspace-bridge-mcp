Workspace Bridge MCP 0.4.0 adds Git review, semantic refactoring and project-task feedback: 41 tools in total.

- Git: safe status/diffs/history, local-confirmed staging/unstaging, and commits bound to a fully reviewed staged patch. No hooks, signing or push. Staging uses raw file bytes. Self-contained roots and local Git identity are required; linked worktrees and special configurations are restricted.
- Refactor: preview multi-file symbol renames, formatting and edit-only quick fixes, then approve one text-only editor transaction. Files remain unsaved for review. Provider-dependent, with strict file/size/expiry/conflict checks.
- Project tasks: discover npm script names and bind execution to package.json. Approve one run or the same task for this bridge session; manifest changes require new approval. Conservative TAP summaries report counts/failures; unsupported output remains unknown. Output is opt-in.
- Permissions: enable edits, refactors, project tasks, Git writes and arbitrary terminal commands separately, for 30 minutes, two hours or this session. Execution still has full account permissions and is not an OS sandbox.
- Long tasks: shared three-active-task cap, up to one hour, and a bounded rolling log that does not stop high-output jobs. Suspected credentials cause output to remain withheld.

Install the attached VSIX, open a trusted folder, then run Workspace Bridge: Open Control Center. Connect a compatible Streamable HTTP client using the copied bearer configuration; keep that secret out of chats and repositories. Default access remains read-only. No automatic tunnel or OAuth server is included.

See docs/V4-WORKFLOWS.md and docs/VALIDATION.md for workflow details, exact validation and remaining limits. Verify the package against SHA256SUMS.txt.
