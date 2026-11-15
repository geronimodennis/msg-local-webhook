# Local Messenger Idle Assistant

This is a local browser watcher for an already-open Facebook Messenger session. It does not use Meta webhooks or expose a public endpoint.

## Setup

1. Install dependencies with `npm.cmd install`.
2. Copy `.env.example` to `.env`.
3. Keep `DRY_RUN=true` while testing.
4. Start Chromium with remote debugging enabled, for example:

   ```powershell
   & "C:\Program Files\Google\Chrome\Application\chrome.exe" `
     --remote-debugging-port=9222 `
     --user-data-dir="$env:TEMP\messenger-watcher-profile"
   ```

5. Log in to Facebook in that browser and open Messenger.
6. Run `npm.cmd start` in a terminal.

Set `DRY_RUN=false` only after the watcher has been verified. This enables real replies through the visible Messenger composer. Configure the idle policy with `IDLE_VALUE` and `IDLE_UNIT` (`seconds` or `minutes`); it defaults to 5 minutes. The watcher monitors `.env` and reloads configuration automatically after edits. Browser connection settings still require a restart.
Inbox messages are recorded by thread and preview in `.watcher-state.json`. Set `DIRECT_CONTACTS` to a comma-separated list of direct-contact names; group messages are eligible only when their preview contains a mention.

See the complete configuration reference in [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md).

## Current implementation boundary

The watcher scans unread inbox cards, records message previews, applies the idle/direct-or-mention policy, persists replied message IDs in `.watcher-state.json`, and sends only when `DRY_RUN=false`. Messenger’s rendered DOM changes frequently, so extraction remains isolated in `src/messenger-browser.js`; update `.env` selectors rather than scattering Facebook selectors through the policy code. Replies must remain limited to direct messages or explicit mentions and must use the configured `[DG's AI assistant]:` prefix.
