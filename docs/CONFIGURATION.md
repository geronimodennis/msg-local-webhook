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
| `CHATBOT_API_URL` | OpenAI-compatible chat-completions URL | Required when `REPLY_MODE=chatbot`. |
| `CHATBOT_API_KEY` | Token or empty | Optional bearer token for the chatbot endpoint. |
| `CHATBOT_MODEL` | Model name | Model sent to the chatbot endpoint. |
| `CHATBOT_TEMPERATURE` | Number, normally `0` to `2` | Generation randomness. |
| `CHATBOT_SYSTEM_PROMPT` | Any text | System instruction for generated replies. |
| `MESSAGE_SELECTOR` | CSS selector | Selector for rendered message elements; Facebook may change this. |
| `COMPOSER_SELECTOR` | CSS selector for a textarea/contenteditable | Selector used to type replies. |

## Account and mention detection

The watcher automatically reads the logged-in Facebook account name from the browser profile. No username setting is required. If `MENTION_PATTERN` is empty, that detected name is used to recognize mentions.

Group messages are eligible only when the mention matches the detected account name or `MENTION_PATTERN`. A generic mention such as `@everyone` does not count as a mention of the logged-in account.

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
