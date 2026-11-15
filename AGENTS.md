# Agent Instructions

- This repository is intended to contain a local Facebook Messenger webhook client that monitors messages and can auto-reply while the user is away.
- The watcher is run manually from a terminal; do not assume a process manager, hosted deployment, or background service.
- Keep the idle threshold configurable; the intended default is 5 minutes since the message was not opened/seen.
- Auto-reply only to direct messages or messages that mention the user. Do not reply to unrelated group conversation.
- Format every automatic response exactly as `[DG's AI assistant]: <agent message>`.
- Preserve the distinction between message receipt time and seen/open status when implementing idle detection.
- No repository-specific build, test, lint, or typecheck commands are documented yet; inspect newly added manifests and scripts before choosing commands.
