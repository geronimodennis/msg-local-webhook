# Configuration

This project locally simulates a webhook for Messenger through the browser. The CLI is designed to expand to other messaging apps later:

```powershell
msg-local-webhook --for messenger --start
```

Copy `.env.example` to `.env` and edit the values below. The watcher reloads these settings automatically while running. Browser connection settings require a restart.

| Property | Accepted values | Purpose |
| --- | --- | --- |
| `BROWSER_CDP_URL` | Reachable `http(s)` Chrome DevTools URL; default `http://127.0.0.1:9222` | Connects to the logged-in browser. |
| `MESSENGER_URL` | Messenger inbox URL | Browser destination; normally `https://www.facebook.com/messages`. |
| `DRY_RUN` | `true` or `false` | `true` logs candidates without sending; `false` enables live replies. |
| `IDLE_VALUE` | Positive number | Idle threshold amount. |
| `IDLE_UNIT` | `seconds` or `minutes` | Unit for `IDLE_VALUE`. |
| `POLL_SECONDS` | Positive number | How often the inbox is checked. |
| `DIRECT_CONTACTS` | Comma-separated exact Messenger names, or empty | Direct contacts eligible for replies. |
| `MENTION_PATTERN` | JavaScript regular expression, or empty | Optional override for matching mentions in group messages. |
| `REPLY_PREFIX` | Any text | Prefix added to every reply. |
| `REPLY_TEXT` | Any non-empty text | Reply body. |
| `REPLY_MODE` | `static` or `chatbot` | Uses `REPLY_TEXT` or generates a reply through the chatbot endpoint. |
| `CHATBOT_FALLBACK_TEXT` | Any non-empty text | Reply body used when chatbot generation fails. |
| `CHATBOT_API_URL` | OpenAI-compatible URL, ending in `/v1` or `/v1/chat/completions` | Required when `REPLY_MODE=chatbot`; `/v1` is expanded automatically. |
| `CHATBOT_API_KEY` | Token or empty | Optional bearer token for the chatbot endpoint. |
| `CHATBOT_MODEL` | Model name | Model sent to the chatbot endpoint. |
| `CHATBOT_VERBOSE_LOGGING` | `true` or `false` | Logs model, prompt/context sizes, vision status, enabled tools, requests, tool use, response sizes, retries, and fallback errors without logging message contents; default `true`. |
| `CHATBOT_RESCAN_BEFORE_REPLY` | `true` or `false` | Forces one fresh conversation rescan before generation; default `false`. |
| `CHATBOT_TEMPERATURE` | Number, normally `0` to `2` | Generation randomness. |
| `CHATBOT_CONTEXT_MESSAGES` | Positive integer; defaults to `1` when unset | Number of newest previous conversation messages sent to the chatbot. |
| `CHATBOT_CACHE_DIRECTORY` | Relative or absolute directory | Location of per-message chatbot cache files; default `.cache`. |
| `CHATBOT_CACHE_MAX_CHARS` | Positive number | Cache size threshold that triggers summarization and replacement. |
| `CHATBOT_CACHE_COMPRESSION` | `true` or `false` | Enables gzip cache files; `false` writes readable JSON files. |
| `CHATBOT_WEB_MAX_CHARS` | Positive number | Maximum characters returned from each web tool; default `8000`. |
| `CHATBOT_WEB_MAX_CALLS` | Positive number, capped at 5 | Maximum web-tool calls per reply; default `3`. |
| `rescan_conversation` | Chatbot tool | Lets the model rescan the currently open Messenger conversation when cached context is insufficient. |
| `inspect_current_conversation` | Chatbot tool | Captures the currently open Messenger view and attaches it as an image. Use only when the configured model supports vision. |
| `CHATBOT_SYSTEM_PROMPT` | Any text | System instruction for generated replies. The current sender and incoming message are added separately for every request. |
| `MESSAGE_SELECTOR` | CSS selector | Selector for rendered message elements; Facebook may change this. |
| `COMPOSER_SELECTOR` | CSS selector for a textarea/contenteditable | Selector used to type replies. |

## Model metadata

The selected `CHATBOT_MODEL` loads its capabilities and permitted tools from `.ai-metadata/<model>.info`. Windows-safe filenames replace characters such as `:` with `_`; for example, `qwen3.5:9b` uses `.ai-metadata/qwen3.5_9b.info`. Web access and vision are enabled only when both the model capability and the corresponding tool are declared in metadata.

## Account and mention detection

The watcher automatically reads the logged-in Facebook account name from the browser profile. No username setting is required. If `MENTION_PATTERN` is empty, that detected name is used to recognize mentions.

Group messages are eligible only when the mention matches the detected account name or `MENTION_PATTERN`. A generic mention such as `@everyone` does not count as a mention of the logged-in account.

## Conversation cache

Each incoming message gets a cache file in `.cache/`. With compression disabled, the cache is readable JSON. The cache stores the newest conversation exchanges and the assistant's confirmed replies. `CHATBOT_CONTEXT_MESSAGES` controls how many recent Messenger messages are added on each response. When the cache exceeds `CHATBOT_CACHE_MAX_CHARS`, the chatbot summarizes the conversation while preserving important facts, questions, commitments, dates, and chronological meaning, then replaces the oversized cache. Both JSON and gzip cache files remain readable.

Cache identity combines Messenger's conversation ID and display name:
`<conversation-id>|<thread-name>`. For example: `100071871884140|Randomguy Fivehundredseventeen`. The combination is hashed for the cache filename. Individual message IDs/text are still used for reply deduplication.

## Deep conversation scanning

The initial scan uses the newest `CHATBOT_CONTEXT_MESSAGES` messages. When `CHATBOT_RESCAN_BEFORE_REPLY=true`, the first chatbot request is forced to call `rescan_conversation` with the next older offset. The chatbot can then request additional pages:

- offset `20`: messages 21–40
- offset `40`: messages 41–60
- offset `60`: messages 61–80

Each retrieved older page is added to the per-message cache. The model decides when the existing context is sufficient; it should stop scanning once it has enough relevant context.
Messenger may return overlapping virtualized pages; the watcher deduplicates timestamped message entries and automatically probes deeper offsets when a requested page contains no new messages.

The `.cache/` directory is local runtime data and is excluded from Git.

## Example

```env
DRY_RUN=true
IDLE_VALUE=5
IDLE_UNIT=minutes
POLL_SECONDS=15
DIRECT_CONTACTS=Alice Example,Bob Example
MENTION_PATTERN=
REPLY_PREFIX=[DG's AI assistant]:
REPLY_TEXT=I’m away right now and will get back to you when I can.
```

For a short test interval:

```env
IDLE_VALUE=10
IDLE_UNIT=seconds
```
