# Agent Instructions

- This is a local browser watcher for Facebook Messenger, not a Meta webhook/API integration. It attaches to an already logged-in Chrome instance over CDP (`127.0.0.1:9222`).
- The project purpose is to simulate a webhook locally through a browser first, with a future expansion path for additional messaging apps. The user-facing CLI is `localwebhook --for messenger --start`.
- The watcher is intentionally run manually in a terminal; do not add a process manager or hosted-service assumption.
- Setup and all `.env` properties are documented in `README.md` and `docs/CONFIGURATION.md`; keep those docs synchronized with configuration changes.
- Idle timing is configurable with `IDLE_VALUE` plus `IDLE_UNIT` (`seconds` or `minutes`); the intended default is 5 minutes since the message was not seen.
- `.env` changes reload while the watcher runs, but browser connection changes require a watcher restart. `.env` is ignored and must never be committed.
- Reply only to configured direct contacts or to group messages that mention the automatically detected logged-in account. Never treat generic mentions such as `@everyone` as a personal mention.
- Preserve receipt time versus seen/open state when changing idle detection. Persist deduplication/reply state in `.watcher-state.json`.
- Every reply must use the exact prefix `[DG's AI assistant]: <agent message>`.
- Never deselect a conversation until Messenger exposes a confirmed `Message sent ... by You` receipt; then return to `/messages/t/`.
- Keep `DRY_RUN=true` for testing; only `DRY_RUN=false` enables live sending.
- Run `npm.cmd test` after changes; the package is published as `@geronimodennis/localwebhook` and release versions must be bumped before npm publishing.
